"""
DraftUrgency.py

Live, per-pick "who should I take right now" recommendation.

SCORING MODEL (refactored - replaces the earlier three-factor product):

    urgency_score = P(gone by my next pick) x (impact_now - impact_fallback)

Read as: "the points per game I expect to regret if I pass on this player."
Both terms are honest quantities:

  - impact_now: how much MY optimal starting lineup's total PPG improves if
    I add this player to my actual current roster. Folds in position-of-need
    for free - a redundant player displaces nobody and nets ~0.
  - impact_fallback: the same number for whoever I'd realistically get at
    this position at my next turn instead. Tier cliffs fall out of this
    automatically: if the fallback sits across a tier boundary, the
    difference is large without needing a separate tier_cliff multiplier.
  - P(gone): Poisson tail on the expected number of picks at this position
    between now and my next turn, compared against this player's own rank
    at the position. A top-of-position player is at risk after very few
    picks; a deep one needs many.

Why this replaced the previous version (both were real bugs, keep them fixed):

  1. urgency was `net_impact * (1 - survival) * tier_cliff`, and tier_cliff
     was scaled by `fraction_depleted`, which is 0 for every intact tier.
     At the start of a draft that made EVERY urgency score exactly 0.00.
     Multiplying three quantities in three different units also produced a
     number with no interpretable meaning.
  2. results were sorted by (tier ASC, urgency DESC) GLOBALLY - not within
     position, despite the comment saying so. Every tier-1 player at every
     position floated to the top and urgency only broke ties inside a tier
     band, so the output was effectively just a tier list. Sorting is now
     purely by urgency_score; tier is returned for display only.

Read-only, no writes: reads live picks from DynamoDB, static reference data
(draft_score/tier, ADP, config) from S3, returns a ranked list.

Access pattern: needs "all picks so far" AND "picks for a specific team."
The draft-state table is tiny (a couple hundred items), so this does ONE
Scan per invocation and groups by team in Python rather than adding a GSI.

Static reference data doesn't change during a draft - cached in a
module-level global, re-fetched only on cold start. Only the DynamoDB scan
is fresh every call.

    GET /draft-urgency?hidden=entity_id:pos,entity_id:pos,...
        -> 200 [{"entity_id", "pos", "proj_fpts_pg", "draft_score", "tier",
                 "impact_now", "fallback_entity_id", "impact_fallback",
                 "gone_probability", "expected_position_picks",
                 "urgency_score"}, ...]
        Sorted by urgency_score descending. Undrafted, unhidden players
        only - `hidden` (optional) excludes a client's hidden-players list
        from the pool exactly like a real pick, so survival/fallback/
        impact math treats them as already gone without them actually
        being drafted or belonging to anyone's roster.

Deploy notes:
    - Runtime: Python 3.12. Needs the duckdb layer.
    - Role: dynamodb:Scan on the draft-state table, s3:GetObject on
      "gold/facts/*" and "config/*".
    - Env: BUCKET_NAME, DRAFT_STATE_TABLE_NAME, LC_ALL=C.UTF-8,
      LANG=C.UTF-8, PYTHONUTF8=1.
    - Timeout: 15-20s is plenty.
"""

import decimal
import json
import logging
import math
import os

import boto3
import duckdb

os.environ.setdefault("HOME", "/tmp")

BUCKET_NAME = os.environ["BUCKET_NAME"]
DRAFT_STATE_TABLE_NAME = os.environ["DRAFT_STATE_TABLE_NAME"]

POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]

# Generous loop bound for _picks_until_next_turn's search, matching the
# frontend's identical bound. The real gap walked each call is however many
# picks separate one of my turns from the next.
_TURN_SEARCH_BOUND = 1000

# Multipliers on a team's per-pick rate for a position, by how much room
# they have for it. Deliberately lean - not config-driven yet.
NEED_STARTER = 1.5
NEED_BENCH_ONLY = 1.0
NEED_NO_ROOM = 0.3

# How many of the next best-ADP undrafted players to look at when
# estimating "what fraction of picks around here tend to be this position."
# 12 = roughly one round.
BASE_RATE_WINDOW = 12

# Guard on the Poisson CDF loop - a player ranked deeper than this at his
# position is not realistically at risk in a single pick gap.
_MAX_RANK_FOR_RISK = 200

log = logging.getLogger(__name__)
log.setLevel(logging.INFO)

s3 = boto3.client("s3")
draft_state_table = boto3.resource("dynamodb").Table(DRAFT_STATE_TABLE_NAME)

_static_cache: dict | None = None


def _response(status_code: int, body) -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def _read_config(name: str, default: dict) -> dict:
    try:
        obj = s3.get_object(Bucket=BUCKET_NAME, Key=f"config/{name}.json")
        return json.loads(obj["Body"].read())
    except s3.exceptions.NoSuchKey:
        return default


def _load_static_data() -> dict:
    """Everything that doesn't change during a draft. Loaded once per
    execution environment."""
    global _static_cache
    if _static_cache is not None:
        return _static_cache

    con = duckdb.connect()
    con.sql("SET home_directory='/tmp';")
    con.sql("INSTALL httpfs; LOAD httpfs;")
    con.sql("CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION 'ca-central-1');")

    bucket_uri = f"s3://{BUCKET_NAME}"
    rows = con.sql(f"""
        select
          fds.entity_id
        , fds.pos
        , fds.proj_fpts_pg
        , fds.draft_score
        , fds.tier
        , adp.ADP as adp_rank
        from read_parquet('{bucket_uri}/gold/facts/fact_draft_scores.parquet', union_by_name = true) fds
        left outer join read_parquet('{bucket_uri}/gold/facts/fact_adp.parquet', union_by_name = true) adp
          on fds.entity_id = adp.entity_id
    """).fetchall()

    columns = ["entity_id", "pos", "proj_fpts_pg", "draft_score", "tier", "adp_rank"]
    players = []
    for row in rows:
        rec = dict(zip(columns, row))
        for key in ("proj_fpts_pg", "draft_score"):
            if isinstance(rec[key], decimal.Decimal):
                rec[key] = float(rec[key])
        if rec[key] is None:
            rec[key] = 0.0
        if isinstance(rec["adp_rank"], decimal.Decimal):
            rec["adp_rank"] = int(rec["adp_rank"])
        rec["proj_fpts_pg"] = float(rec["proj_fpts_pg"] or 0)
        rec["draft_score"] = float(rec["draft_score"] or 0)
        players.append(rec)

    _static_cache = {
        "players": players,
        "roster_positions": _read_config("roster_positions", {"slots": []}).get("slots", []),
        "draft_order": _read_config("draft_order", {"draft_type": "snake", "team_order": []}),
        "my_team": _read_config("my_team", {"team_name": None}).get("team_name"),
    }
    return _static_cache


def _get_all_picks() -> list[dict]:
    items = draft_state_table.scan().get("Items", [])
    for item in items:
        item["pick_number"] = int(item["pick_number"])
    return items


def _compute_on_the_clock(team_order: list[str], draft_type: str, pick_number: int) -> str | None:
    """Snake/round-robin math. Kept in lockstep with the frontend's
    computeOnTheClock in webapp/src/pages/DraftBoardPage.jsx."""
    n = len(team_order)
    if n == 0:
        return None
    rnd = (pick_number - 1) // n
    idx = (pick_number - 1) % n
    if draft_type == "snake" and rnd % 2 == 1:
        return team_order[n - 1 - idx]
    return team_order[idx]


def _picks_until_next_turn(team_order: list[str], draft_type: str, pick_number: int, team: str | None) -> int | None:
    """Total picks before `team` is next on the clock, counting from the
    pick right after `pick_number` - answers "what do I risk by NOT
    drafting right now."""
    if not team or len(team_order) == 0:
        return None
    for n in range(pick_number + 1, pick_number + _TURN_SEARCH_BOUND):
        if _compute_on_the_clock(team_order, draft_type, n) == team:
            return n - pick_number
    return None


def _compute_slot_fill(team_picks: list[dict], roster_positions: list[dict]) -> list[dict]:
    """Python port of webapp/src/lib/rosterSlots.js's computeSlotFill -
    greedy most-specific-slot-first (dedicated slots fill before
    FLEX/SUPERFLEX)."""
    assigned: set[int] = set()
    ordered_slots = sorted(roster_positions, key=lambda s: len(s["eligible_positions"]))

    filled_by_slot: dict[str, int] = {}
    for slot in ordered_slots:
        filled = 0
        for _ in range(slot["count"]):
            idx = next(
                (j for j, p in enumerate(team_picks)
                 if j not in assigned and p["pos"] in slot["eligible_positions"]),
                None,
            )
            if idx is None:
                break
            assigned.add(idx)
            filled += 1
        filled_by_slot[slot["slot_name"]] = filled

    return [
        {
            "slot_name": s["slot_name"],
            "count": s["count"],
            "filled": filled_by_slot.get(s["slot_name"], 0),
            "open": s["count"] - filled_by_slot.get(s["slot_name"], 0),
            "eligible_positions": s["eligible_positions"],
        }
        for s in roster_positions
    ]


def _open_starter_capacity(slot_fill: list[dict], position: str) -> int:
    """Open non-BENCH slots eligible for this position. Covers SUPERFLEX
    with no position-specific special-casing - any slot whose
    eligible_positions includes QB counts, dedicated or not."""
    return sum(
        s["open"] for s in slot_fill
        if s["slot_name"] != "BENCH" and s["open"] > 0 and position in s["eligible_positions"]
    )


def _has_bench_room(slot_fill: list[dict], position: str) -> bool:
    return any(
        s["slot_name"] == "BENCH" and s["open"] > 0 and position in s["eligible_positions"]
        for s in slot_fill
    )


def _base_rate(position: str, pick_number: int, undrafted: list[dict]) -> float:
    """Of the next BASE_RATE_WINDOW best-ADP undrafted players from this
    pick onward, what fraction play this position."""
    with_adp = sorted((p for p in undrafted if p["adp_rank"] is not None), key=lambda p: p["adp_rank"])
    window = [p for p in with_adp if p["adp_rank"] >= pick_number][:BASE_RATE_WINDOW]
    if not window:
        window = with_adp[-BASE_RATE_WINDOW:] if with_adp else []
    if not window:
        return 1.0 / len(POSITIONS)
    return sum(1 for p in window if p["pos"] == position) / len(window)


def _tendency_adjustment(position: str, team_picks: list[dict], adp_by_entity: dict[str, int]) -> float:
    """Linear scaling off this team's own average (pick_number - ADP) at
    this position so far. Reaching early scales up, letting value fall
    scales down. No prior picks there -> neutral."""
    deltas = [
        p["pick_number"] - adp_by_entity[p["entity_id"]]
        for p in team_picks
        if p.get("pos") == position and p["entity_id"] in adp_by_entity
    ]
    if not deltas:
        return 1.0
    avg_delta = sum(deltas) / len(deltas)
    return max(0.5, min(1.5, 1.0 - avg_delta * 0.02))


def _expected_position_picks(
    position: str,
    pick_number: int,
    picks: list[dict],
    undrafted: list[dict],
    draft_order: dict,
    my_team: str,
    roster_positions: list[dict],
    adp_by_entity: dict[str, int],
) -> float:
    """Expected NUMBER of picks at `position` between now and my next turn.

    Walked SEQUENTIALLY with running per-team state, not evaluated
    independently per team: a team picking twice in the same window (the
    snake round-turn) can have its need change between its own two picks.
    `probable_filled` is a soft expected-value running total, not a Monte
    Carlo sample - cheap, and enough to carry state forward correctly.

    The walk covers pick_number through pick_number + n_until - 1.
    pick_number + n_until is my own turn. Starting at pick_number + 1 was a
    real bug: it silently skipped the very next pick, which is total when
    n_until == 1 (zero picks evaluated, everything defaults to safe).
    """
    team_order = draft_order.get("team_order", [])
    draft_type = draft_order.get("draft_type", "snake")

    n_until = _picks_until_next_turn(team_order, draft_type, pick_number, my_team)
    if not n_until:
        return 0.0

    team_picks: dict[str, list[dict]] = {t: [p for p in picks if p["team"] == t] for t in team_order}
    probable_filled: dict[str, float] = {t: 0.0 for t in team_order}

    expected = 0.0
    for offset in range(0, n_until):
        pick_n = pick_number + offset
        team = _compute_on_the_clock(team_order, draft_type, pick_n)
        if team is None or team == my_team:
            continue

        slot_fill = _compute_slot_fill(team_picks[team], roster_positions)
        remaining_capacity = _open_starter_capacity(slot_fill, position) - probable_filled[team]

        if remaining_capacity > 0:
            need_adj = NEED_STARTER
        elif _has_bench_room(slot_fill, position):
            need_adj = NEED_BENCH_ONLY
        else:
            need_adj = NEED_NO_ROOM

        rate = _base_rate(position, pick_n, undrafted) * need_adj * _tendency_adjustment(
            position, team_picks[team], adp_by_entity
        )
        rate = max(0.0, min(1.0, rate))

        expected += rate
        probable_filled[team] += rate

    return expected


def _gone_probability(rank: int, expected_picks: float) -> float:
    """P(at least `rank` players at this position are taken before my next
    turn) - i.e. the chance this specific player is gone.

    Poisson(expected_picks) tail rather than the old ad hoc
    `1 - expected/rank`, which went negative for top-ranked players and
    was not a probability at all. P(gone) = 1 - P(X < rank).
    """
    if rank <= 0:
        return 1.0
    if expected_picks <= 0:
        return 0.0
    if rank > _MAX_RANK_FOR_RISK:
        return 0.0

    # P(X < rank) = sum_{i=0}^{rank-1} e^-lam * lam^i / i!
    term = math.exp(-expected_picks)
    cdf = term
    for i in range(1, rank):
        term *= expected_picks / i
        cdf += term
    return max(0.0, min(1.0, 1.0 - cdf))


def _optimal_lineup_ppg(players: list[dict], roster_positions: list[dict]) -> float:
    """Greedy value-maximizing lineup assignment: highest proj_fpts_pg gets
    first claim on the most specific still-open eligible slot. Sums PPG
    across non-BENCH assignments only - bench players don't score."""
    ordered_slots = sorted(roster_positions, key=lambda s: len(s["eligible_positions"]))
    players_sorted = sorted(players, key=lambda p: -(p["proj_fpts_pg"] or 0))
    assigned = [False] * len(players_sorted)

    total = 0.0
    for slot in ordered_slots:
        remaining = slot["count"]
        for i, p in enumerate(players_sorted):
            if remaining == 0:
                break
            if assigned[i] or p["pos"] not in slot["eligible_positions"]:
                continue
            assigned[i] = True
            remaining -= 1
            if slot["slot_name"] != "BENCH":
                total += p["proj_fpts_pg"] or 0
    return total


def handler(event, context):
    try:
        static_data = _load_static_data()
        roster_positions = static_data["roster_positions"]
        draft_order = static_data["draft_order"]
        my_team = static_data["my_team"]
        all_players = static_data["players"]

        picks = _get_all_picks()
        picked_keys = {(p["entity_id"], p["pos"]) for p in picks}
        adp_by_entity = {p["entity_id"]: p["adp_rank"] for p in all_players if p["adp_rank"] is not None}

        # Hidden players (a client-side, per-browser preference - "I'm not
        # drafting this guy, stop showing him up top") are passed in as a
        # query param and excluded from the AVAILABLE pool exactly like a
        # real pick, so survival/fallback/impact math all treats them as
        # already gone. Deliberately NOT added to `picks`/`picked_keys`
        # themselves - hiding a player doesn't actually advance the draft
        # or belong to any team's roster, it just removes them from
        # everyone's pool of realistic options for this one call.
        query_params = event.get("queryStringParameters") or {}
        hidden_keys = set()
        for pair in (query_params.get("hidden") or "").split(","):
            if ":" in pair:
                entity_id, pos = pair.split(":", 1)
                hidden_keys.add((entity_id, pos))

        undrafted = [
            p for p in all_players
            if (p["entity_id"], p["pos"]) not in picked_keys
            and (p["entity_id"], p["pos"]) not in hidden_keys
        ]
        pick_number = len(picks) + 1

        # Position-level forecast: computed once per position (6 total),
        # shared across every player at that position.
        expected_by_position = {
            pos: _expected_position_picks(
                pos, pick_number, picks, undrafted, draft_order, my_team, roster_positions, adp_by_entity,
            )
            for pos in POSITIONS
        }

        # Undrafted players at each position, best draft_score first. Index
        # in this list IS the player's rank at his position, and is also
        # what identifies the realistic fallback.
        pool_by_position: dict[str, list[dict]] = {
            pos: sorted((p for p in undrafted if p["pos"] == pos), key=lambda p: -p["draft_score"])
            for pos in POSITIONS
        }

        # My actual current roster, joined to proj_fpts_pg - the baseline
        # every impact number is measured against.
        players_by_key = {(p["entity_id"], p["pos"]): p for p in all_players}
        my_players = []
        if my_team:
            for pick in picks:
                if pick["team"] != my_team:
                    continue
                player = players_by_key.get((pick["entity_id"], pick["pos"]))
                my_players.append({
                    "pos": pick["pos"],
                    "proj_fpts_pg": player["proj_fpts_pg"] if player else 0.0,
                })

        baseline_ppg = _optimal_lineup_ppg(my_players, roster_positions) if my_team else 0.0

        # impact_now is looked up per player; fallback impacts repeat
        # heavily across candidates at the same position, so memoize.
        impact_cache: dict[str, float] = {}

        def impact_of(player: dict) -> float:
            key = player["entity_id"]
            if key not in impact_cache:
                impact_cache[key] = _optimal_lineup_ppg(my_players + [player], roster_positions) - baseline_ppg
            return impact_cache[key]

        results = []
        for pos, pool in pool_by_position.items():
            expected_picks = expected_by_position.get(pos, 0.0)
            # Whoever I'd realistically still find at this position at my
            # next turn, if the expected number of picks here happens.
            fallback_idx = int(round(expected_picks))

            for idx, p in enumerate(pool):
                rank = idx + 1
                gone_prob = _gone_probability(rank, expected_picks)

                impact_now = impact_of(p) if my_team else p["proj_fpts_pg"]

                # Never "fall back" to someone ahead of this player - the
                # realistic replacement is the better of (expected
                # survivor, next man down from this candidate).
                fb_idx = max(idx + 1, fallback_idx)
                if fb_idx < len(pool):
                    fallback = pool[fb_idx]
                    impact_fallback = impact_of(fallback) if my_team else fallback["proj_fpts_pg"]
                    fallback_entity_id = fallback["entity_id"]
                else:
                    # Position exhausted past this point - nothing to fall
                    # back to, so the full impact is at risk.
                    impact_fallback = 0.0
                    fallback_entity_id = None

                regret = max(0.0, impact_now - impact_fallback)
                urgency_score = gone_prob * regret

                results.append({
                    "entity_id": p["entity_id"],
                    "pos": p["pos"],
                    "proj_fpts_pg": round(p["proj_fpts_pg"], 2),
                    "draft_score": round(p["draft_score"], 2),
                    "tier": p["tier"],
                    "position_rank": rank,
                    "impact_now": round(impact_now, 2),
                    "fallback_entity_id": fallback_entity_id,
                    "impact_fallback": round(impact_fallback, 2),
                    "regret_if_missed": round(regret, 2),
                    "gone_probability": round(gone_prob, 4),
                    "expected_position_picks": round(expected_picks, 2),
                    "urgency_score": round(urgency_score, 2),
                })

        # Sorted purely by urgency. Tier is returned for display, NOT used
        # as a sort key - the previous global (tier ASC, urgency DESC) sort
        # floated every tier-1 player at every position (K and DST
        # included) to the top and reduced the output to a tier list.
        results.sort(key=lambda r: -r["urgency_score"])
        return _response(200, results)
    except Exception as e:
        log.exception("Failed to compute draft urgency")
        return _response(500, {"error": str(e)})
