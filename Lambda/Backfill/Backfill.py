"""
BackfillLambda.py

Lambda version of BronzeBackfill.py - pulls raw NFL data via nflreadpy and
writes it as partitioned parquet to the S3 bronze layer, triggered from the
web app's admin panel via API Gateway. Job status is tracked in DynamoDB so
the admin panel can poll for real success/failure instead of just trusting
that "started" means "worked."

This function handles three things, dispatched inside one handler:
  1. POST /admin/backfill (API Gateway, synchronous) - validates auth/input,
     writes a "running" job record to DynamoDB, async-invokes ITSELF (via
     boto3, InvocationType="Event") with a `_worker` marker + job id, and
     immediately returns 202 with the job id. API Gateway's HTTP API type
     only supports synchronous Lambda invocation - there's no built-in
     "invoke and don't wait" option like REST API's non-proxy integration
     has, hence the self-invoke instead of a native async integration.
  2. The detached worker invocation (triggered by #1, never touches API
     Gateway) - does the actual pull/write, then updates the same
     DynamoDB job record with the final status/results. Free of both API
     Gateway's 30s integration timeout and any client-side wait, since
     nothing is listening for its return value.
  3. GET /admin/backfill/status/{jobId} (API Gateway, synchronous) - reads
     the job record from DynamoDB and returns it, so the frontend can poll
     until status is no longer "running".

Expected API Gateway (Lambda proxy) event body for POST:
    {
        "seasons": [2021, 2022, 2023, 2024, 2025],
        "purge": false
    }

`seasons` is capped at 15 and cannot include the current year (that
season isn't complete yet) - validated here independently of the admin
panel's own year-picker limits, since this endpoint could be called
directly.

Auth: API Gateway's Cognito authorizer confirms identity before invoking
this function. This function additionally checks the `cognito:groups`
claim itself - Cognito does NOT enforce group-based authorization on its
own, every protected endpoint must check the claim independently (see
docs/project-summary.md, item 4). Uses the same route -> allowed-groups
pattern intended for shared/permissions_config.py once that lands; inlined
here for now since this is the first protected Lambda. Only the API
Gateway-triggered paths (POST and GET) check this - the self-invoked
worker payload never passes through API Gateway/Cognito again, so it
skips the check entirely (the entry path already gated it before kicking
the worker off).

Deploy notes (console-first, see chat):
    - Runtime: Python 3.12+, needs nflreadpy + polars + boto3 in a layer
      or deployment package (boto3 is included in the base runtime, the
      other two are not).
    - Execution role: needs s3:PutObject (and s3:ListBucket / s3:DeleteObject
      if `purge` is used) scoped to bronze/* on the bucket below, PLUS
      lambda:InvokeFunction scoped to this function's own ARN (for the
      self-invoke), PLUS dynamodb:PutItem/UpdateItem/GetItem scoped to the
      jobs table ARN - NOT the "fantasy-football-pipeline" IAM
      user/profile used for local dev.
    - Set the BUCKET_NAME and JOBS_TABLE_NAME environment variables on the
      function - these are what differ between the dev and prod deploys of
      this same code.
    - DynamoDB table: partition key `job_id` (String). Enable TTL on the
      `expires_at` attribute so old job records clean themselves up
      automatically instead of accumulating forever.
    - API Gateway routes, both with the Cognito JWT authorizer attached,
      both Lambda proxy integration, both pointing at this function:
        POST /admin/backfill
        GET  /admin/backfill/status/{jobId}
    - Timeout: the entry paths (POST and GET) only validate/read and
      return fast - a short timeout (10-15s) is fine there. The worker
      invocation runs as a *separate* Lambda execution with its own
      timeout, so it can be set generously (several minutes) without
      affecting API Gateway's 30s integration cap at all, since API
      Gateway never waits on it.
"""

import io
import json
import logging
import os
import time
import uuid
from datetime import datetime

import boto3
import nflreadpy as nfl
import polars as pl

# Set via the Lambda's environment variables so the same code/layer can be
# deployed to a "backfill-dev" function (pointed at dev resources) and a
# "backfill-prod" function (pointed at prod) without any code diff.
BUCKET_NAME = os.environ["BUCKET_NAME"]
JOBS_TABLE_NAME = os.environ["JOBS_TABLE_NAME"]
ADMIN_GROUP = "admin"
MAX_SEASONS = 15
JOB_TTL_SECONDS = 7 * 24 * 60 * 60  # 7 days - matches the DynamoDB TTL attribute below

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

s3 = boto3.client("s3")
lambda_client = boto3.client("lambda")
jobs_table = boto3.resource("dynamodb").Table(JOBS_TABLE_NAME)

DATASETS = {
    "rosters": lambda season: nfl.load_rosters(seasons=[season]),
    "weekly_stats": lambda season: nfl.load_player_stats(seasons=[season]),
    "depth_charts": lambda season: nfl.load_depth_charts(seasons=[season]),
    "draft_picks": lambda season: nfl.load_draft_picks(seasons=[season]),
    "injuries": lambda season: nfl.load_injuries(seasons=[season]),
}


def _response(status_code: int, body: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        # default=str handles the Decimal values DynamoDB's resource API
        # returns for numbers (e.g. created_at) - not worth a stricter
        # converter since the frontend only displays these, never does math.
        "body": json.dumps(body, default=str),
    }


def _is_admin(event: dict) -> bool:
    authorizer = event.get("requestContext", {}).get("authorizer", {})
    # HTTP API + JWT authorizer nests claims under "jwt"; REST API + Cognito
    # authorizer puts them directly under "authorizer" - support both.
    claims = authorizer.get("jwt", {}).get("claims", {}) or authorizer.get("claims", {})
    groups = claims.get("cognito:groups", "")

    if isinstance(groups, list):
        return ADMIN_GROUP in groups
    if groups.startswith("["):
        # HTTP API JSON-encodes array claims into a string, e.g. '["admin"]'.
        try:
            return ADMIN_GROUP in json.loads(groups)
        except json.JSONDecodeError:
            pass
    # REST API's Cognito authorizer flattens the claim to a comma-separated
    # string instead.
    return ADMIN_GROUP in groups.split(",")


def _create_job(job_id: str, seasons: list[int], purge: bool) -> None:
    now = int(time.time())
    jobs_table.put_item(Item={
        "job_id": job_id,
        "status": "running",
        "message": f"Backfill running for {len(seasons)} season(s).",
        "written": [],
        "errors": [],
        "seasons": seasons,
        "purge": purge,
        "created_at": now,
        "updated_at": now,
        "expires_at": now + JOB_TTL_SECONDS,
    })


def _finish_job(job_id: str, status: str, result: dict) -> None:
    jobs_table.update_item(
        Key={"job_id": job_id},
        UpdateExpression=(
            "SET #status = :status, #message = :message, "
            "written = :written, errors = :errors, updated_at = :updated_at"
        ),
        ExpressionAttributeNames={"#status": "status", "#message": "message"},
        ExpressionAttributeValues={
            ":status": status,
            ":message": result["message"],
            ":written": result["written"],
            ":errors": result["errors"],
            ":updated_at": int(time.time()),
        },
    )


def _get_job(job_id: str) -> dict | None:
    return jobs_table.get_item(Key={"job_id": job_id}).get("Item")


def _purge_partition(dataset: str, season: int) -> None:
    prefix = f"bronze/{dataset}/season={season}/"
    resp = s3.list_objects_v2(Bucket=BUCKET_NAME, Prefix=prefix)
    for obj in resp.get("Contents", []):
        s3.delete_object(Bucket=BUCKET_NAME, Key=obj["Key"])


def _write_partition(df: pl.DataFrame, dataset: str, season: int) -> str | None:
    if df is None or df.is_empty():
        log.warning(f"  No data for {dataset} season={season}, skipping.")
        return None

    key = f"bronze/{dataset}/season={season}/{dataset}.parquet"
    buffer = io.BytesIO()
    df.write_parquet(buffer)
    buffer.seek(0)
    s3.put_object(Bucket=BUCKET_NAME, Key=key, Body=buffer.getvalue())
    log.info(f"  Wrote {df.height:,} rows -> s3://{BUCKET_NAME}/{key}")
    return key


def _run_backfill(seasons: list[int], purge: bool) -> dict:
    """The actual work - only runs inside the detached async worker invocation."""
    written = []
    errors = []

    for dataset, loader in DATASETS.items():
        for season in seasons:
            try:
                if purge:
                    _purge_partition(dataset, season)
                df = loader(season)
                key = _write_partition(df, dataset, season)
                if key:
                    written.append(key)
            except Exception as e:
                log.warning(f"  Failed {dataset} season={season}: {e}")
                errors.append(f"{dataset} season={season}: {e}")

    result = {
        "message": f"Backfill complete: {len(written)} partitions written"
        + (f", {len(errors)} errors." if errors else "."),
        "written": written,
        "errors": errors,
    }
    log.info(result["message"])
    return result


def _validate_request(body: dict) -> tuple[list[int] | None, bool, dict | None]:
    """Returns (seasons, purge, error_response). error_response is None if valid."""
    seasons = body.get("seasons")
    purge = bool(body.get("purge", False))

    if not seasons or not isinstance(seasons, list):
        return None, purge, _response(400, {"error": "`seasons` must be a non-empty list of ints."})

    if len(seasons) > MAX_SEASONS:
        return None, purge, _response(400, {"error": f"`seasons` cannot span more than {MAX_SEASONS} years."})

    current_year = datetime.now().year
    if any(season >= current_year for season in seasons):
        return None, purge, _response(400, {
            "error": f"`seasons` cannot include {current_year} or later - that season isn't complete yet.",
        })

    return seasons, purge, None


def _handle_worker(event: dict) -> None:
    job_id = event["jobId"]
    try:
        result = _run_backfill(event["seasons"], event["purge"])
        status = "failed" if result["errors"] else "success"
        _finish_job(job_id, status, result)
    except Exception as e:
        # Without this, a crash here would leave the job stuck on "running"
        # forever, since nothing else ever updates the record.
        log.exception("Worker crashed")
        _finish_job(job_id, "failed", {"message": str(e), "written": [], "errors": [str(e)]})


def _handle_status_check(event: dict) -> dict:
    job_id = (event.get("pathParameters") or {}).get("jobId")
    if not job_id:
        return _response(400, {"error": "Missing jobId."})

    job = _get_job(job_id)
    if not job:
        return _response(404, {"error": "Job not found."})

    return _response(200, job)


def _handle_start_backfill(event: dict, context) -> dict:
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "Invalid JSON body."})

    seasons, purge, error_response = _validate_request(body)
    if error_response:
        return error_response

    job_id = str(uuid.uuid4())
    _create_job(job_id, seasons, purge)

    lambda_client.invoke(
        FunctionName=context.invoked_function_arn,
        InvocationType="Event",
        Payload=json.dumps({"_worker": True, "jobId": job_id, "seasons": seasons, "purge": purge}),
    )

    return _response(202, {
        "jobId": job_id,
        "status": "running",
        "message": f"Backfill started for {len(seasons)} season(s).",
    })


def handler(event, context):
    if event.get("_worker"):
        return _handle_worker(event)

    if not _is_admin(event):
        return _response(403, {"error": "Admin access required."})

    method = event.get("requestContext", {}).get("http", {}).get("method", "POST")
    if method == "GET":
        return _handle_status_check(event)

    return _handle_start_backfill(event, context)
