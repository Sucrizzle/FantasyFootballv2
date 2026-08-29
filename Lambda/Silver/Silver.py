"""
Silver.py

Cleans bronze `rosters` data into a single, standardized silver parquet file
via DuckDB (reads/writes S3 parquet directly, no download step). Pure
technical cleansing per source, matching this project's medallion
definition (see docs/project-summary.md): standardizes column values (team
abbreviation normalization via a crosswalk file) but does NOT change grain
(still one row per player per week, same as bronze) and does NOT join
across sources - that grain change and cross-source joining is gold's job
(building `dim_player` etc.), not silver's.

Currently handles only `rosters` - other bronze sources get their own
cleansing logic added here (or split into their own functions) as gold's
needs surface them, matching the project's "start close to pass-through,
add cleaning rules as real data issues are found" approach.

Job status is tracked in the same shared DynamoDB jobs table BronzeBackfill
uses (`job_type` distinguishes which pipeline stage a record belongs to),
so the admin panel can eventually show real success/failure for this stage
too, not just bronze. Unlike BronzeBackfill, this runs synchronously in a
single invocation - there's no API Gateway route in front of this function
(so no 30s integration timeout to dodge), so the async self-invoke/worker
split bronze needs doesn't apply here.

Not yet wired to a trigger - intended to eventually be invoked
asynchronously by BronzeBackfill's worker on successful completion (see
issue tracking the consolidated "Run Data Pipeline" admin button), so
running the full bronze -> silver pipeline is a single admin action rather
than a separate manual step. For now, invoke directly via the Lambda
console Test tab or `aws lambda invoke` for manual runs.

Deploy notes (console-first, matching BronzeBackfill.py's pattern):
    - Runtime: Python 3.12 specifically - NOT 3.14 like BronzeBackfill uses.
      duckdb doesn't yet publish cp314 wheels (confirmed via chat), only up
      to 3.12 at time of writing. Needs the `duckdb` package in a layer -
      separate from BronzeBackfill's nflreadpy+polars layer, built for
      cp312 (manylinux2014_x86_64), since this Lambda doesn't need either
      of bronze's dependencies.
    - Execution role: needs s3:ListBucket (with s3:prefix condition
      covering "bronze/*" and "mappings/*") on the bucket, PLUS
      s3:GetObject on "bronze/*" and "mappings/*", PLUS s3:PutObject on
      "silver/*", PLUS dynamodb:PutItem/UpdateItem scoped to the jobs
      table ARN - NOT the "fantasy-football-pipeline" IAM user/profile
      used for local dev.
    - Set the BUCKET_NAME and JOBS_TABLE_NAME environment variables -
      differ between dev and prod deploys of this same code.
    - Timeout: DuckDB reading/joining/writing this volume of data should be
      well under a minute, but give it real headroom (60-120s) since S3
      round-trips through httpfs add latency the local DBeaver testing
      didn't have to account for.
"""

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
JOB_TYPE = "silver_rosters"

# logging.basicConfig() is a no-op under the Lambda runtime - see
# BronzeBackfill.py for why. Set the logger's level explicitly instead.
log = logging.getLogger(__name__)
log.setLevel(logging.INFO)

jobs_table = boto3.resource("dynamodb").Table(JOBS_TABLE_NAME)

ROSTERS_QUERY = """
    COPY (
        select
          r.season
        , cm_t.target as team
        , r.position
        , r.depth_chart_position
        , r.jersey_number
        , r.status
        , r.full_name
        , r.first_name
        , r.last_name
        , r.birth_date
        , r.height
        , r.weight
        , r.college
        , r.gsis_id
        , r.yahoo_id
        , r.pff_id
        , r.years_exp
        , r.headshot_url
        , r.week
        , r.game_type
        , r.football_name
        , r.rookie_year
        , COALESCE(cm_dc.target, 'UDFA') as draft_club
        , r.draft_number
        from read_parquet(
            'BUCKET_PLACEHOLDER/bronze/rosters/season=*/rosters.parquet',
            union_by_name = true
        ) r
        left outer join read_csv('BUCKET_PLACEHOLDER/mappings/club_mapping.csv') cm_t
          on r.team = cm_t.source
        left outer join read_csv('BUCKET_PLACEHOLDER/mappings/club_mapping.csv') cm_dc
          on r.draft_club = cm_dc.source
        where r.season > 2015 -- 2015 is NULLs in key columns
    ) TO 'BUCKET_PLACEHOLDER/silver/rosters/rosters.parquet' (FORMAT PARQUET);
"""


def _create_job(job_id: str) -> None:
    now = int(time.time())
    jobs_table.put_item(Item={
        "job_id": job_id,
        "job_type": JOB_TYPE,
        "status": "running",
        "message": "Silver rosters cleansing running.",
        "created_at": now,
        "updated_at": now,
    })


def _finish_job(job_id: str, status: str, message: str) -> None:
    jobs_table.update_item(
        Key={"job_id": job_id},
        UpdateExpression="SET #status = :status, #message = :message, updated_at = :updated_at",
        ExpressionAttributeNames={"#status": "status", "#message": "message"},
        ExpressionAttributeValues={
            ":status": status,
            ":message": message,
            ":updated_at": int(time.time()),
        },
    )


def _clean_rosters(con: duckdb.DuckDBPyConnection) -> None:
    bucket_uri = f"s3://{BUCKET_NAME}"
    query = ROSTERS_QUERY.replace("BUCKET_PLACEHOLDER", bucket_uri)
    con.sql(query)
    log.info(f"Wrote silver/rosters/rosters.parquet to {bucket_uri}")


def handler(event, context):
    job_id = str(uuid.uuid4())
    _create_job(job_id)

    try:
        con = duckdb.connect()
        # DuckDB needs a writable home directory to install/cache extensions
        # like httpfs. Lambda's environment doesn't provide one (HOME is
        # unset, filesystem is read-only outside /tmp) - point it at /tmp,
        # the one writable location Lambda guarantees.
        con.sql("SET home_directory='/tmp';")
        con.sql("INSTALL httpfs; LOAD httpfs;")
        # No PROVIDER needed here (unlike local DBeaver testing) - the
        # Lambda's own execution role credentials are picked up
        # automatically via the standard AWS credential chain, same as
        # boto3 does elsewhere in this project.
        con.sql("CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION 'ca-central-1');")

        _clean_rosters(con)
    except Exception as e:
        # Without this, a crash here would leave the job stuck on "running"
        # forever, since nothing else ever updates the record.
        log.exception("Silver rosters cleansing crashed")
        _finish_job(job_id, "failed", str(e))
        return {"statusCode": 500, "body": f"jobId={job_id}, error={e}"}

    _finish_job(job_id, "success", "Silver rosters cleaned successfully.")
    return {"statusCode": 200, "body": f"jobId={job_id}, Silver rosters cleaned successfully."}
