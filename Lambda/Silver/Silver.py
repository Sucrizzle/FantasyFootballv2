"""
Silver.py

Generic silver-layer runner: reads a manifest describing which SQL queries
to run and where to write their output, executes each one via DuckDB
(reads/writes S3 parquet directly, no download step), and tracks status in
DynamoDB. Adding a new silver transform (e.g. depth_charts) is just adding
a new .sql file + a manifest entry - no code change or redeploy needed for
that. Code changes are only needed for genuinely new *logic* (e.g. the
depth_charts schedule-join derivation), not for new pass-through-style
cleansing queries.

Manifest and query files live in S3 (uploaded via the same CI/CD step that
uploads the mapping CSVs - see Lambda/Silver/queries/ in the repo, and
.github/workflows/deploy-FantasyFootballManager.yml), at:
    s3://<bucket>/silver-queries/manifest.json
    s3://<bucket>/silver-queries/<query_file>

Manifest shape (see Lambda/Silver/queries/manifest.json for the real one):
    [
      {"name": "rosters", "query_file": "rosters.sql", "output_path": "silver/rosters/rosters.parquet"},
      ...
    ]

Each query file is a plain SELECT (no COPY wrapper) - this runner wraps it
in `COPY (<query>) TO '<output_path>' (FORMAT PARQUET)` itself, using the
manifest's output_path. Query files use the same BUCKET_PLACEHOLDER
convention as before for the bucket URI, substituted at runtime so the same
files work unchanged across dev/prod.

Matches this project's medallion definition (see docs/project-summary.md):
pure technical cleansing per source - standardizes column values (team
abbreviation normalization via a crosswalk file) but does NOT change grain
and does NOT join across *different* bronze sources (only within one
source's own schema-era differences, e.g. rosters/schedules each join
against the mapping CSV, which is reference data, not another bronze
source). Cross-source joins (e.g. depth_charts + schedules) are gold's job.

One job record per invocation, covering all manifest entries - if one
entry fails, the others still run (matching BronzeBackfill's per-dataset
error isolation), and the job's `errors` list records which entries failed
and why.

Triggered via the interim "Run Silver" admin panel button (see
AdminPage.jsx) - intended to eventually also be invoked asynchronously by
BronzeBackfill's worker on successful completion (see issue tracking the
consolidated "Run Data Pipeline" admin button).

Async entry/worker split, same pattern and same reason as
BronzeBackfill.py: API Gateway's HTTP API type has a hard, non-configurable
~29-30s integration timeout, separate from whatever timeout is set on the
Lambda itself. This was synchronous originally (fine when it only ran one
fast query), but once it grew to 5 queries taking ~76s total, API Gateway
started timing out the request before the Lambda finished - even though
the Lambda kept running in the background and completed successfully. The
entry path now validates + async self-invokes a worker + returns 202
immediately; the worker (detached, no API Gateway involved) does the
actual multi-query run and updates the same DynamoDB job record.

Deploy notes (console-first, matching BronzeBackfill.py's pattern):
    - Runtime: Python 3.12 specifically - NOT 3.14 like BronzeBackfill uses.
      duckdb doesn't yet publish cp314 wheels (confirmed via chat), only up
      to 3.12 at time of writing. Needs the `duckdb` package in a layer -
      separate from BronzeBackfill's nflreadpy+polars layer.
    - Execution role: needs s3:ListBucket (with s3:prefix condition
      covering "bronze/*", "mappings/*", and "silver-queries/*") on the
      bucket, PLUS s3:GetObject on those same three prefixes, PLUS
      s3:PutObject on "silver/*", PLUS dynamodb:PutItem/UpdateItem scoped
      to the jobs table ARN, PLUS lambda:InvokeFunction scoped to this
      function's own ARN (for the self-invoke).
    - Set the BUCKET_NAME and JOBS_TABLE_NAME environment variables -
      differ between dev and prod deploys of this same code.
    - API Gateway routes, both with the Cognito JWT authorizer attached,
      both Lambda proxy integration, both pointing at this function:
        POST /admin/silver
        GET  /admin/silver/status/{jobId}
    - Environment variables LC_ALL=C.UTF-8, LANG=C.UTF-8, PYTHONUTF8=1 -
      Lambda's minimal environment has no locale set, which some code path
      (DuckDB's own extension handling, or Python's encoding fallback)
      consults directly, causing UnicodeDecodeError on non-ASCII data
      (accented player names, etc.) if unset. Must be set as actual Lambda
      environment variables, not in code - locale initialization happens
      at process startup, before this module's code runs.
    - Timeout: the entry path only validates and kicks off the async
      invoke, so it returns in well under a second - a short timeout
      (10-15s) is fine there. The worker invocation runs as a *separate*
      Lambda execution with its own timeout, so it can be set generously
      (several minutes) without affecting API Gateway's 30s integration
      cap at all, since API Gateway never waits on it.
"""

import json
import logging
import os
import time
import uuid

import boto3
import duckdb

# Lambda's environment doesn't set HOME at all. DuckDB's own extension
# cache respects a SQL-level `SET home_directory`, but the `aws` extension
# (auto-installed by `CREATE SECRET ... PROVIDER credential_chain`) checks
# the OS-level HOME env var directly instead - setting it here, before
# duckdb ever runs a query, covers both code paths. Must happen before any
# duckdb.connect()/con.sql() call, so it's set at import time, not inside
# the handler.
os.environ.setdefault("HOME", "/tmp")

BUCKET_NAME = os.environ["BUCKET_NAME"]
JOBS_TABLE_NAME = os.environ["JOBS_TABLE_NAME"]
JOB_TYPE = "silver"
ADMIN_GROUP = "admin"
MANIFEST_KEY = "silver/queries/manifest.json"
QUERIES_PREFIX = "silver/queries/"

# logging.basicConfig() is a no-op under the Lambda runtime - see
# BronzeBackfill.py for why. Set the logger's level explicitly instead.
log = logging.getLogger(__name__)
log.setLevel(logging.INFO)

s3 = boto3.client("s3")
lambda_client = boto3.client("lambda")
jobs_table = boto3.resource("dynamodb").Table(JOBS_TABLE_NAME)


def _response(status_code: int, body: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def _is_admin(event: dict) -> bool:
    # Same claim-parsing logic as BronzeBackfill.py - see that file for why
    # this specific shape (HTTP API's JWT authorizer serializes array claims
    # as a bracket-wrapped, comma-separated, NON-json-quoted string like
    # "[admin]", not valid JSON).
    authorizer = event.get("requestContext", {}).get("authorizer", {})
    claims = authorizer.get("jwt", {}).get("claims", {}) or authorizer.get("claims", {})
    groups = claims.get("cognito:groups", "")

    if isinstance(groups, list):
        return ADMIN_GROUP in groups
    if groups.startswith("[") and groups.endswith("]"):
        members = [g.strip() for g in groups[1:-1].split(",") if g.strip()]
        return ADMIN_GROUP in members
    return ADMIN_GROUP in groups.split(",")


def _create_job(job_id: str) -> None:
    now = int(time.time())
    jobs_table.put_item(Item={
        "job_id": job_id,
        "job_type": JOB_TYPE,
        "status": "running",
        "message": "Silver run in progress.",
        "written": [],
        "errors": [],
        "created_at": now,
        "updated_at": now,
    })


def _finish_job(job_id: str, status: str, written: list[str], errors: list[str]) -> None:
    message = f"Silver run complete: {len(written)} output(s) written" + (
        f", {len(errors)} error(s)." if errors else "."
    )
    jobs_table.update_item(
        Key={"job_id": job_id},
        UpdateExpression=(
            "SET #status = :status, #message = :message, "
            "written = :written, errors = :errors, updated_at = :updated_at"
        ),
        ExpressionAttributeNames={"#status": "status", "#message": "message"},
        ExpressionAttributeValues={
            ":status": status,
            ":message": message,
            ":written": written,
            ":errors": errors,
            ":updated_at": int(time.time()),
        },
    )


def _get_job(job_id: str) -> dict | None:
    return jobs_table.get_item(Key={"job_id": job_id}).get("Item")


def _load_manifest() -> list[dict]:
    obj = s3.get_object(Bucket=BUCKET_NAME, Key=MANIFEST_KEY)
    return json.loads(obj["Body"].read())


def _load_query(query_file: str) -> str:
    obj = s3.get_object(Bucket=BUCKET_NAME, Key=f"{QUERIES_PREFIX}{query_file}")
    return obj["Body"].read().decode("utf-8")


def _run_entry(con: duckdb.DuckDBPyConnection, entry: dict) -> None:
    bucket_uri = f"s3://{BUCKET_NAME}"
    select_sql = _load_query(entry["query_file"]).replace("BUCKET_PLACEHOLDER", bucket_uri)
    output_uri = f"{bucket_uri}/{entry['output_path']}"
    con.sql(f"COPY ({select_sql}) TO '{output_uri}' (FORMAT PARQUET);")
    log.info(f"[{entry['name']}] wrote {output_uri}")


def _run_all(con: duckdb.DuckDBPyConnection) -> tuple[list[str], list[str]]:
    written = []
    errors = []

    manifest = _load_manifest()
    for entry in manifest:
        try:
            _run_entry(con, entry)
            written.append(entry["name"])
        except Exception as e:
            log.warning(f"[{entry['name']}] failed: {e}")
            errors.append(f"{entry['name']}: {e}")

    return written, errors


def _handle_worker(event: dict) -> None:
    job_id = event["jobId"]

    try:
        con = duckdb.connect()
        # DuckDB needs a writable home directory to install/cache extensions
        # like httpfs. Lambda's environment doesn't provide one (HOME is
        # unset, filesystem is read-only outside /tmp) - point it at /tmp,
        # the one writable location Lambda guarantees.
        con.sql("SET home_directory='/tmp';")
        con.sql("INSTALL httpfs; LOAD httpfs;")
        # icu provides real IANA timezone data (DST-aware conversions via
        # the timezone() function) - needed by schedules.sql's
        # gameday/gametime -> UTC game_datetime standardization, and by any
        # future query needing the same. Loaded once here rather than
        # per-query, since it's a connection-level concern, not something
        # individual .sql files (plain SELECT statements) should repeat.
        con.sql("INSTALL icu; LOAD icu;")
        # No PROVIDER needed here (unlike local DBeaver testing) - the
        # Lambda's own execution role credentials are picked up
        # automatically via the standard AWS credential chain, same as
        # boto3 does elsewhere in this project.
        con.sql("CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION 'ca-central-1');")

        written, errors = _run_all(con)
    except Exception as e:
        # Manifest/query-loading failures land here (never got to run any
        # entry at all) - without this, the job would be stuck on "running"
        # forever.
        log.exception("Silver run crashed before any entry could run")
        _finish_job(job_id, "failed", [], [str(e)])
        return

    # "success" even with partial errors, matching BronzeBackfill's
    # per-dataset isolation - only fully "failed" if NOTHING wrote
    # successfully. The `errors` list itself still surfaces partial
    # failures either way.
    status = "failed" if not written and errors else "success"
    _finish_job(job_id, status, written, errors)


def _handle_start_silver(context) -> dict:
    job_id = str(uuid.uuid4())
    _create_job(job_id)

    lambda_client.invoke(
        FunctionName=context.invoked_function_arn,
        InvocationType="Event",
        Payload=json.dumps({"_worker": True, "jobId": job_id}),
    )

    return _response(202, {
        "jobId": job_id,
        "status": "running",
        "message": "Silver run started.",
    })


def _handle_status_check(event: dict) -> dict:
    job_id = (event.get("pathParameters") or {}).get("jobId")
    if not job_id:
        return _response(400, {"error": "Missing jobId."})

    job = _get_job(job_id)
    if not job:
        return _response(404, {"error": "Job not found."})

    return _response(200, job)


def handler(event, context):
    if event.get("_worker"):
        return _handle_worker(event)

    if not _is_admin(event):
        return _response(403, {"error": "Admin access required."})

    method = event.get("requestContext", {}).get("http", {}).get("method", "POST")
    if method == "GET":
        return _handle_status_check(event)

    return _handle_start_silver(context)
