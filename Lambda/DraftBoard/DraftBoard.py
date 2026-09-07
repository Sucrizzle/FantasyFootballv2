"""
DraftBoard.py

Read-only endpoint serving the draft board to the web app. Deliberately
reads straight from S3/DuckDB on every request rather than syncing into
DynamoDB first - for MVP1's actual scale (single user, a few hundred
rows, refreshed only when Gold reruns), a DynamoDB sync step is avoidable
complexity that doesn't pay for itself at this usage pattern (Lambda/S3
costs here are a rounding error against the Always Free tier regardless).
Revisit if/when multiple concurrent users make a shared serving cache
worth the engineering cost (MVP2).

No admin gating - unlike Bronze/Silver/Gold/Config, every authenticated
user should see the draft board, not just admins. API Gateway's Cognito
JWT authorizer already confirms the caller is signed in; that's the only
check this needs.

Synchronous, no async job pattern - reading one small parquet file is
fast, nowhere near API Gateway's ~30s integration timeout.

Reads its SQL from an external query file (see
Lambda/DraftBoard/queries/draft_board.sql) rather than embedding it
inline as a Python string - same convention Silver/Gold use for their
query files, and keeps the query maintainable as it grows (more joins,
more positions). The dim_team enrichment join lives in that query file,
not in fact_draft_scores.sql itself - fact_draft_scores is a fact table
and should hold keys (entity_id), not denormalized dimension attributes
like team_name; that join belongs at serve time, in the query that's
actually producing a display-ready result for the UI.

Manifest-free, unlike Silver/Gold - this is always exactly one query, so
there's no need for a manifest/multiple-query-files abstraction, just a
single query file loaded directly.

Expected API Gateway (Lambda proxy) route, with the Cognito JWT authorizer
attached:
    GET /draft-board
        -> 200 [{"entity_id": "...", "pos": "...", "team_abbr": "...",
                 "player_name": "...", "proj_fpts_pg": ...,
                 "r_fpts_pg": ..., "draft_score": ...}, ...]

Deploy notes:
    - Runtime: Python 3.12 (matches Silver/Gold - duckdb has no cp314
      wheels yet). Needs the duckdb layer, same one Silver/Gold use.
    - Execution role: needs s3:GetObject scoped to "gold/facts/*",
      "gold/dimensions/*", and "draft-board/queries/*" - read-only,
      nothing else.
    - Set the BUCKET_NAME environment variable.
    - Environment variables LC_ALL=C.UTF-8, LANG=C.UTF-8, PYTHONUTF8=1 -
      same DuckDB locale gotcha as Silver/Gold (see those files).
    - Timeout: short (10-15s) is plenty for reading one small file.
    - Query file deployed to S3 the same way Silver/Gold's are - see
      .github/workflows/deploy-FantasyFootballManager.yml's "Upload
      DraftBoard query files" step.
"""

import decimal
import json
import logging
import os

import boto3
import duckdb

# See Silver.py/Gold.py for why this must happen at import time, before
# any duckdb.connect()/con.sql() call.
os.environ.setdefault("HOME", "/tmp")

BUCKET_NAME = os.environ["BUCKET_NAME"]
QUERY_KEY = "draft-board/queries/draft_board.sql"

log = logging.getLogger(__name__)
log.setLevel(logging.INFO)

s3 = boto3.client("s3")


def _response(status_code: int, body) -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def _load_query() -> str:
    obj = s3.get_object(Bucket=BUCKET_NAME, Key=QUERY_KEY)
    return obj["Body"].read().decode("utf-8")


def handler(event, context):
    try:
        con = duckdb.connect()
        con.sql("SET home_directory='/tmp';")
        con.sql("INSTALL httpfs; LOAD httpfs;")
        con.sql("CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION 'ca-central-1');")

        bucket_uri = f"s3://{BUCKET_NAME}"
        select_sql = _load_query().replace("${bucket}", bucket_uri)

        rel = con.sql(select_sql)
        columns = rel.columns
        rows = rel.fetchall()
        # DuckDB DECIMAL columns (proj_fpts_pg, r_fpts_pg, draft_score -
        # anything cast via try_cast(... as decimal(...))) come back as
        # Python decimal.Decimal, which json.dumps can't serialize
        # natively - without this, _response's default=str fallback would
        # silently stringify them (e.g. "1.23" instead of 1.23), which
        # breaks numeric sorting client-side even though the value looks
        # fine at a glance.
        results = [
            {col: (float(val) if isinstance(val, decimal.Decimal) else val) for col, val in zip(columns, row)}
            for row in rows
        ]

        return _response(200, results)
    except Exception as e:
        log.exception("Failed to read draft board")
        return _response(500, {"error": str(e)})
