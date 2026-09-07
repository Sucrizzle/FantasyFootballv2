"""
DraftBoard.py

Read-only endpoint serving the gold-layer draft board (fact_draft_scores)
to the web app. Deliberately reads straight from S3/DuckDB on every
request rather than syncing into DynamoDB first - for MVP1's actual scale
(single user, a few hundred rows, refreshed only when Gold reruns), a
DynamoDB sync step is avoidable complexity that doesn't pay for itself at
this usage pattern (Lambda/S3 costs here are a rounding error against the
Always Free tier regardless). Revisit if/when multiple concurrent users
make a shared serving cache worth the engineering cost (MVP2).

No admin gating - unlike Bronze/Silver/Gold/Config, every authenticated
user should see the draft board, not just admins. API Gateway's Cognito
JWT authorizer already confirms the caller is signed in; that's the only
check this needs.

Synchronous, no async job pattern - reading one small parquet file is
fast, nowhere near API Gateway's ~30s integration timeout.

Expected API Gateway (Lambda proxy) route, with the Cognito JWT authorizer
attached:
    GET /draft-board
        -> 200 [{"entity_id": "...", "pos": "...", "team": "...",
                 "proj_fpts_pg": ..., "r_fpts_pg": ..., "draft_score": ...}, ...]

Deploy notes:
    - Runtime: Python 3.12 (matches Silver/Gold - duckdb has no cp314
      wheels yet). Needs the duckdb layer, same one Silver/Gold use.
    - Execution role: needs s3:GetObject scoped to
      "gold/facts/fact_draft_scores.parquet" (or s3:ListBucket+GetObject
      scoped to "gold/facts/*") - read-only, nothing else.
    - Set the BUCKET_NAME environment variable.
    - Environment variables LC_ALL=C.UTF-8, LANG=C.UTF-8, PYTHONUTF8=1 -
      same DuckDB locale gotcha as Silver/Gold (see those files).
    - Timeout: short (10-15s) is plenty for reading one small file.
"""

import json
import logging
import os

import duckdb

# See Silver.py/Gold.py for why this must happen at import time, before
# any duckdb.connect()/con.sql() call.
os.environ.setdefault("HOME", "/tmp")

BUCKET_NAME = os.environ["BUCKET_NAME"]

log = logging.getLogger(__name__)
log.setLevel(logging.INFO)


def _response(status_code: int, body) -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def handler(event, context):
    try:
        con = duckdb.connect()
        con.sql("SET home_directory='/tmp';")
        con.sql("INSTALL httpfs; LOAD httpfs;")
        con.sql("CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION 'ca-central-1');")

        rel = con.sql(
            f"SELECT * FROM read_parquet('s3://{BUCKET_NAME}/gold/facts/fact_draft_scores.parquet')"
        )
        columns = rel.columns
        rows = rel.fetchall()
        results = [dict(zip(columns, row)) for row in rows]

        return _response(200, results)
    except Exception as e:
        log.exception("Failed to read draft board")
        return _response(500, {"error": str(e)})
