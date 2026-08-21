"""
BackfillLambda.py

Lambda version of BronzeBackfill.py - pulls raw NFL data via nflreadpy and
writes it as partitioned parquet to the S3 bronze layer, triggered
synchronously from the web app's admin panel via API Gateway.

Runs in seconds even across several seasons, so this is invoked
synchronously (web app awaits the HTTP response directly) rather than an
async-invoke-and-poll pattern - no job-status table needed.

Expected API Gateway (Lambda proxy) event body:
    {
        "years": [2021, 2022, 2023, 2024, 2025, 2026],
        "purge": false
    }

Auth: API Gateway's Cognito authorizer confirms identity before invoking
this function. This function additionally checks the `cognito:groups`
claim itself - Cognito does NOT enforce group-based authorization on its
own, every protected endpoint must check the claim independently (see
docs/project-summary.md, item 4). Uses the same route -> allowed-groups
pattern intended for shared/permissions_config.py once that lands; inlined
here for now since this is the first protected Lambda.

Deploy notes (console-first, see chat):
    - Runtime: Python 3.12+, needs nflreadpy + polars + boto3 in a layer
      or deployment package (boto3 is included in the base runtime, the
      other two are not).
    - Execution role: needs s3:PutObject (and s3:ListBucket / s3:DeleteObject
      if `purge` is used) scoped to bronze/* on the bucket below - NOT the
      "fantasy-football-pipeline" IAM user/profile used for local dev.
    - Set BUCKET_NAME below or move to an env var if it should differ
      between deploys.
    - API Gateway route: POST /admin/backfill, Cognito authorizer attached,
      Lambda proxy integration.
"""

import io
import json
import logging

import boto3
import nflreadpy as nfl
import polars as pl

BUCKET_NAME = "fantasy-football-808943963151-ca-central-1-an"
ADMIN_GROUP = "admin"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

s3 = boto3.client("s3")

DATASETS = {
    "rosters": lambda year: nfl.load_rosters(seasons=[year]),
    "weekly_stats": lambda year: nfl.load_player_stats(seasons=[year]),
    "depth_charts": lambda year: nfl.load_depth_charts(seasons=[year]),
    "draft_picks": lambda year: nfl.load_draft_picks(seasons=[year]),
    "injuries": lambda year: nfl.load_injuries(seasons=[year]),
}


def _response(status_code: int, body: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _is_admin(event: dict) -> bool:
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("claims", {})
    )
    groups = claims.get("cognito:groups", "")
    # API Gateway flattens this claim to a comma-separated string or a
    # single group name, not a JSON list.
    return ADMIN_GROUP in groups.split(",")


def _purge_partition(dataset: str, year: int) -> None:
    prefix = f"bronze/{dataset}/season={year}/"
    resp = s3.list_objects_v2(Bucket=BUCKET_NAME, Prefix=prefix)
    for obj in resp.get("Contents", []):
        s3.delete_object(Bucket=BUCKET_NAME, Key=obj["Key"])


def _write_partition(df: pl.DataFrame, dataset: str, year: int) -> str | None:
    if df is None or df.is_empty():
        log.warning(f"  No data for {dataset} season={year}, skipping.")
        return None

    key = f"bronze/{dataset}/season={year}/{dataset}.parquet"
    buffer = io.BytesIO()
    df.write_parquet(buffer)
    buffer.seek(0)
    s3.put_object(Bucket=BUCKET_NAME, Key=key, Body=buffer.getvalue())
    log.info(f"  Wrote {df.height:,} rows -> s3://{BUCKET_NAME}/{key}")
    return key


def handler(event, context):
    if not _is_admin(event):
        return _response(403, {"error": "Admin access required."})

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "Invalid JSON body."})

    years = body.get("years")
    purge = bool(body.get("purge", False))

    if not years or not isinstance(years, list):
        return _response(400, {"error": "`years` must be a non-empty list of ints."})

    written = []
    errors = []

    for dataset, loader in DATASETS.items():
        for year in years:
            try:
                if purge:
                    _purge_partition(dataset, year)
                df = loader(year)
                key = _write_partition(df, dataset, year)
                if key:
                    written.append(key)
            except Exception as e:
                log.warning(f"  Failed {dataset} season={year}: {e}")
                errors.append(f"{dataset} season={year}: {e}")

    return _response(200, {
        "message": f"Backfill complete: {len(written)} partitions written"
        + (f", {len(errors)} errors." if errors else "."),
        "written": written,
        "errors": errors,
    })
