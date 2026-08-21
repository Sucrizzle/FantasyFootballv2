"""
backfill_bronze.py

One-time historical backfill: pulls raw NFL data via nflreadpy and lands
it as partitioned parquet files in the S3 "bronze" layer.

NOTE: nfl_data_py was archived by its maintainers in Sep 2025 and is no
longer updated. This script uses its maintained successor, nflreadpy,
which nflverse now publishes current-season data through. nflreadpy
returns polars DataFrames (not pandas) - this script writes parquet
directly via polars, no pandas conversion needed.

This is meant to be run LOCALLY (not as a Lambda) since a multi-year,
multi-dataset pull can take a while and there's no benefit to running it
serverless for a one-time backfill.

Usage:
    python backfill_bronze.py

Requires:
    pip install nflreadpy polars boto3

Auth:
    Uses the "fantasy-football-pipeline" AWS CLI profile explicitly
    (see s3_session below) - no need to set AWS_PROFILE manually.
"""

import io
import logging
from datetime import datetime

import boto3
import nflreadpy as nfl
import polars as pl

# ---------------------------------------------------------------------------
# Configuration - edit these for your setup
# ---------------------------------------------------------------------------

BUCKET_NAME = "fantasy-football-808943963151-ca-central-1-an"

# Last 5 completed seasons PLUS the current year, so depth charts/injuries/
# rosters/draft picks reflect current preseason data. Weekly stats for the
# current year will come back sparse or empty until games are played -
# write_partition() already skips empty results gracefully.
CURRENT_YEAR = datetime.now().year
YEARS = list(range(CURRENT_YEAR - 5, CURRENT_YEAR + 1))  # e.g. 2021-2026

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

s3_session = boto3.Session(profile_name="fantasy-football-pipeline")
s3 = s3_session.client("s3")


# ---------------------------------------------------------------------------
# Helper: write a polars DataFrame to S3 as parquet, partitioned by season
# ---------------------------------------------------------------------------

def write_partition(df: pl.DataFrame, dataset: str, season: int) -> None:
    """Write one season's worth of a dataset to bronze/<dataset>/season=<year>/<dataset>.parquet"""
    if df is None or df.is_empty():
        log.warning(f"  No data for {dataset} season={season}, skipping.")
        return

    key = f"bronze/{dataset}/season={season}/{dataset}.parquet"

    buffer = io.BytesIO()
    df.write_parquet(buffer)
    buffer.seek(0)

    s3.put_object(Bucket=BUCKET_NAME, Key=key, Body=buffer.getvalue())
    log.info(f"  Wrote {df.height:,} rows -> s3://{BUCKET_NAME}/{key}")


# ---------------------------------------------------------------------------
# Pull functions - one per dataset
#
# NOTE ON API: nflreadpy is a newer package - if any of these load_*
# function names or their accepted argument shapes differ slightly from
# what's below, check `help(nfl.load_rosters)` etc. in a REPL and adjust.
# The nflreadpy functions generally accept a `seasons` argument as a
# list[int] (or sometimes a single int), matching the pattern below.
# ---------------------------------------------------------------------------

def pull_rosters(years: list[int]) -> None:
    log.info("Pulling rosters...")
    for year in years:
        try:
            df = nfl.load_rosters(seasons=[year])
        except Exception as e:
            log.warning(f"  Could not fetch rosters for season={year}: {e}")
            continue
        write_partition(df, "rosters", year)


def pull_weekly_stats(years: list[int]) -> None:
    log.info("Pulling weekly stats...")
    for year in years:
        try:
            df = nfl.load_player_stats(seasons=[year])
        except Exception as e:
            log.warning(f"  Could not fetch weekly stats for season={year} (likely no games played yet): {e}")
            continue
        write_partition(df, "weekly_stats", year)


def pull_depth_charts(years: list[int]) -> None:
    log.info("Pulling depth charts...")
    for year in years:
        try:
            df = nfl.load_depth_charts(seasons=[year])
        except Exception as e:
            log.warning(f"  Could not fetch depth charts for season={year}: {e}")
            continue
        write_partition(df, "depth_charts", year)


def pull_draft_picks(years: list[int]) -> None:
    log.info("Pulling draft picks...")
    for year in years:
        try:
            df = nfl.load_draft_picks(seasons=[year])
        except Exception as e:
            log.warning(f"  Could not fetch draft picks for season={year}: {e}")
            continue
        write_partition(df, "draft_picks", year)


def pull_injuries(years: list[int]) -> None:
    log.info("Pulling injuries...")
    for year in years:
        try:
            df = nfl.load_injuries(seasons=[year])
        except Exception as e:
            log.warning(f"  Could not fetch injuries for season={year}: {e}")
            continue
        write_partition(df, "injuries", year)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    log.info(f"Starting backfill for seasons: {YEARS}")
    log.info(f"Target bucket: {BUCKET_NAME}")

    pull_rosters(YEARS)
    pull_weekly_stats(YEARS)
    pull_depth_charts(YEARS)
    pull_draft_picks(YEARS)
    pull_injuries(YEARS)

    log.info("Backfill complete.")


if __name__ == "__main__":
    main()