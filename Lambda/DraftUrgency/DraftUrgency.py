"""
DraftUrgency.py

Live, per-pick "who should I take right now" recommendation. Replaces the
VONA layer described in docs/vona-scoring-model-spec.md - see
docs/realtime-urgency-scoring-spec.md for the full design this implements
(tier-cliff + per-team survival probability + need weighting, combined into
one urgency_score per undrafted player).

Read-only, no writes: reads live picks from DynamoDB, static reference data
(draft_score/tier_cliff, ADP, config) from S3, and returns a ranked list.
Nothing here mutates draft state - that's DraftState.py's job.

Separate Lambda, not folded into DraftBoard.py - different trigger pattern
(needs to run fresh after every pick, not just on page load) and different
responsibility (a live recommendation engine, not a static board read).

Synchronous request-response, not DynamoDB Streams - Streams is the more
"correct" long-term architecture (react to picks as they're written) but
adds real asynchronous complexity (event source mapping, batch/retry
handling) that isn't worth taking on for this timeline. A plain "frontend
asks, Lambda computes and returns" call is simpler to build, debug, and
reason about.

Access pattern (see docs/realtime-urgency-scoring-spec.md section 7): this
needs "all picks so far" AND "all picks so far for a specific team" (used
per team in the survival-probability walk). The draft-state DynamoDB table
is tiny (a couple hundred items at most, ~8KB observed mid-draft) - nowhere
close to the 1MB Scan limit - so this deliberately does ONE Scan per
invocation and groups by team in Python, rather than adding a GSI on `team`
and issuing a separate Query per team. A GSI would only earn its keep at a
scale this table will never reach.

Static reference data (gold draft_score/tier_cliff, ADP, roster_positions/
teams/draft_order/my_team config) doesn't change during a draft - cached in
a module-level global and reused across warm invocations, re-fetched only
on a cold start. Only the DynamoDB picks scan is fetched fresh every call.

Expected API Gateway (Lambda proxy) route, with the Cognito JWT authorizer
attached:
    GET /draft-urgency
        -> 200 [{"entity_id": "...", "pos": "...", "draft_score": ...,
                 "tier": ..., "tier_cliff": ..., "survival_probability": ...,
                 "need_multiplier": ..., "urgency_score": ...}, ...]
        Sorted by urgency_score descending. Only undrafted players -
        there's nothing to recommend about a player who's already gone.

Deploy notes:
    - Runtime: Python 3.12 (matches Silver/Gold/DraftBoard - duckdb has no
      cp314 wheels yet). Needs the duckdb layer, same one those use.
    - Execution role: needs dynamodb:Scan on the draft-state table, plus
      s3:GetObject scoped to "gold/facts/*" and "config/*" - read-only,
      nothing else.
    - Set the BUCKET_NAME and DRAFT_STATE_TABLE_NAME environment variables.
    - Environment variables LC_ALL=C.UTF-8, LANG=C.UTF-8, PYTHONUTF8=1 -
      same DuckDB locale gotcha as Silver/Gold/DraftBoard.
    - Timeout: 15-20s is plenty - one DynamoDB scan, a handful of small S3
      reads (cached after the first cold start), and the survival-
      probability walk is at most 24 iterations per position, 6 positions.
"""

import decimal
import json
import logging
import os

import boto3
import duckdb

os.environ.setdefault("HOME", "/tmp")

BUCKET_NAME = os.environ["BUCKET_NAME"]
DRAFT_STATE_TABLE_NAME = os.environ["DRAFT_STATE_TABLE_NAME"]

POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]

# Not a real forecast cap - just a generous loop bound for
# _picks_until_next_turn's search, matching the frontend's identical search
# bound. The real number of picks actually walked each call is however many
# picks genuinely separate one of the user's turns from the next, which for
# a real league is naturally never more than ~2x the team count (see
# docs/realtime-urgency-scoring-spec.md section 3d's 24-pick worst case for
# a 12-team snake draft) - nothing here hardcodes that 24, it just falls
# out of the real draft_order.
_TURN_SEARCH_BOUND = 1000

# Tunable constants for need_adjustment/need_multiplier - deliberately
# simple/lean, not config-driven yet (see docs/realtime-urgency-scoring-
# spec.md section 8: full behavioral modeling is explicitly out of scope
# for this build cycle). Revisit as real config values if these ever need
# regular tuning the way tier_cliff's band_width did.
NEED_STARTER = 1.5
NEED_BENCH_ONLY = 1.0
NEED_NO_ROOM = 0.3

# Same scale, but for the USER's own need_multiplier (section 4) - kept
# separate from the survival-probability need_adjustment constants above
# since they answer different questions (section 4 up-weights urgency
# directly; section 3b scales an opponent's probability of taking a pick).
NEED_MULTIPLIER_STARTER = 1.2
NEED_MULTIPLIER_BENCH_ONLY = 0.4
NEED_MULTIPLIER_NO_ROOM = 0.15

# ADP-window size for base_rate - how many of the next best-ADP undrafted
# players to look at when estimating "what fraction of picks around here
# tend to be this position." 12 = roughly one round - wide enough for a
# stable estimate, narrow enough to reflect the current draft stage rather
# than the whole board's overall position mix.
BASE_RATE_WINDOW = 12

log = logging.getLogger(__name__)
log.setLevel(logging.INFO)

s3 = boto3.client("s3")
draft_state_table = boto3.resource("dynamodb").Table(DRAFT_STATE_TABLE_NAME)

# Module-level cache for static reference data - populated on first use in
# a given execution environment, reused across warm invocations. See the
# module docstring's "Deploy notes" section.
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
    """Everything that doesn't change during a draft: gold draft_score/
    tier_cliff joined to ADP, roster_positions, draft_order, my_team,
    league team count. Loaded once per execution environment."""
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
        , fds.draft_score
        , fds.tier
        , fds.tier_cliff
        , adp.ADP as adp_rank
        from read_parquet('{bucket_uri}/gold/facts/fact_draft_scores.parquet', union_by_name = true) fds
        left outer join read_parquet('{bucket_uri}/gold/facts/fact_adp.parquet', union_by_name = true) adp
          on fds.entity_id = adp.entity_id
    """).fetchall()

    columns = ["entity_id", "pos", "draft_score", "tier", "tier_cliff", "adp_rank"]
    players = []
    for row in rows:
        rec = dict(zip(columns, row))
        for key in ("draft_score", "tier_cliff"):
            if isinstance(rec[key], decimal.Decimal):
                rec[key] = float(rec[key])
        if isinstance(rec["adp_rank"], decimal.Decimal):
            rec["adp_rank"] = int(rec["adp_rank"])
        players.append(rec)

    roster_positions = _read_config("roster_positions", {"slots": []}).get("slots", [])
    draft_order = _read_config("draft_order", {"draft_type": "snake", "team_order": []})
    my_team = _read_config("my_team", {"team_name": None}).get("team_name")

    _static_cache = {
        "players": players,
        "roster_positions": roster_positions,
        "draft_order": draft_order,
        "my_team": my_team,
    }
    return _static_cache


def _get_all_picks() -> list[dict]:
    """One full Scan, not a per-team Query - see module docstring's
    "Access pattern" section for why that's the right call at this table's
    scale. Every caller that needs "picks for team X" filters this same
    result in memory instead of hitting DynamoDB again."""
    items = draft_state_table.scan().get("Items", [])
    for item in items:
        item["pick_number"] = int(item["pick_number"])
    return items


# pick_number is 1-indexed and guaranteed gapless by DraftState.py (server-
# computed, undo-last-only). Same snake/round-robin math as the frontend's
# computeOnTheClock in webapp/src/pages/DraftBoardPage.jsx - kept in
# lockstep deliberately, this is the one source of truth for "whose turn is
# it" duplicated across the JS and Python sides of this app.
def _compute_on_the_clock(team_order: list[str], draft_type: str, pick_number: int) -> str | None:
    n = len(team_order)
    if n == 0:
        return None
    rnd = (pick_number - 1) // n
    idx = (pick_number - 1) % n
    if draft_type == "snake" and rnd % 2 == 1:
        return team_order[n - 1 - idx]
    return team_order[idx]


def _picks_until_next_turn(team_order: list[str], draft_type: str, pick_number: int, team: str | None) -> int | None:
    """How many total picks (across all teams) happen before `team` is next
    on the clock, counting from the pick right after `pick_number` - skips
    the current pick even if it's already this team's turn, matching the
    frontend's picksUntilNextTurn (answers "what do I risk by NOT drafting
    right now," not "how far away is the turn I'm already having")."""
    if not team or len(team_order) == 0:
        return None
    for n in range(pick_number + 1, pick_number + _TURN_SEARCH_BOUND):
        if _compute_on_the_clock(team_order, draft_type, n) == team:
            return n - pick_number
    return None


# Python port of webapp/src/lib/rosterSlots.js's computeSlotFill - same
# greedy most-specific-slot-first algorithm (dedicated slots fill before
# FLEX/SUPERFLEX), kept in lockstep with the JS version deliberately. See
# that file for the full reasoning; not repeated here.
def _compute_slot_fill(picks: list[dict], team: str, roster_positions: list[dict]) -> list[dict]:
    team_picks = [p for p in picks if p["team"] == team]
    assigned_indexes: set[int] = set()

    ordered_slots = sorted(roster_positions, key=lambda s: len(s["eligible_positions"]))

    filled_by_slot: dict[str, int] = {}
    for slot in ordered_slots:
        filled = 0
        for _ in range(slot["count"]):
            idx = next(
                (j for j, p in enumerate(team_picks)
                 if j not in assigned_indexes and p["pos"] in slot["eligible_positions"]),
                None,
            )
            if idx is None:
                break
            assigned_indexes.add(idx)
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


def _open_starting_slots_for_position(slot_fill: list[dict], position: str) -> list[dict]:
    """Non-BENCH slots, still open, eligible for this position. Naturally
    covers superflex (or any other multi-position slot) with no position-
    specific special-casing - a slot whose eligible_positions includes QB
    counts here whether it's QB's own dedicated slot or SUPERFLEX, exactly
    the "either slot open counts as open" rule
    docs/realtime-urgency-scoring-spec.md requires for QB specifically."""
    return [s for s in slot_fill if s["slot_name"] != "BENCH" and s["open"] > 0 and position in s["eligible_positions"]]


def _open_bench_slots_for_position(slot_fill: list[dict], position: str) -> list[dict]:
    return [s for s in slot_fill if s["slot_name"] == "BENCH" and s["open"] > 0 and position in s["eligible_positions"]]


def _need_multiplier(position: str, picks: list[dict], team: str, roster_positions: list[dict]) -> float:
    """Section 4: does this position fill a currently open STARTING slot on
    the user's own roster right now (elevated), only bench depth (reduced),
    or nothing at all (further reduced)."""
    slot_fill = _compute_slot_fill(picks, team, roster_positions)
    if _open_starting_slots_for_position(slot_fill, position):
        return NEED_MULTIPLIER_STARTER
    if _open_bench_slots_for_position(slot_fill, position):
        return NEED_MULTIPLIER_BENCH_ONLY
    return NEED_MULTIPLIER_NO_ROOM


def _base_rate(position: str, pick_number: int, undrafted_players: list[dict]) -> float:
    """League-wide baseline: of the next BASE_RATE_WINDOW best-ADP
    undrafted players from this pick onward, what fraction play this
    position. A data-driven "what tends to go around here" signal derived
    straight from ADP, per docs/realtime-urgency-scoring-spec.md section
    3a - no separate behavioral model needed for the baseline itself."""
    with_adp = sorted((p for p in undrafted_players if p["adp_rank"] is not None), key=lambda p: p["adp_rank"])
    window = [p for p in with_adp if p["adp_rank"] >= pick_number][:BASE_RATE_WINDOW]
    if not window:
        # Nothing with ADP left ahead of this pick (very late in the draft,
        # past ADP's real coverage) - fall back to the tail of the ADP-
        # ranked pool rather than an empty window.
        window = with_adp[-BASE_RATE_WINDOW:] if with_adp else []
    if not window:
        return 1.0 / len(POSITIONS)
    return sum(1 for p in window if p["pos"] == position) / len(window)


def _tendency_adjustment(team: str, position: str, team_picks: list[dict], adp_by_entity: dict[str, int]) -> float:
    """Section 3c, deliberately lean: linear scaling off this team's own
    average (pick_number - player_adp) at this position so far. Reaching
    early (negative average) scales the rate up; letting value fall
    (positive average) scales it down. No prior picks at this position for
    this team -> neutral (1.0), no data to lean on yet."""
    deltas = [
        p["pick_number"] - adp_by_entity[p["entity_id"]]
        for p in team_picks
        if p.get("pos") == position and p["entity_id"] in adp_by_entity
    ]
    if not deltas:
        return 1.0
    avg_delta = sum(deltas) / len(deltas)
    return max(0.5, min(1.5, 1.0 - avg_delta * 0.02))


def _compute_survival_probability(
    position: str,
    pick_number: int,
    picks: list[dict],
    undrafted_players: list[dict],
    draft_order: dict,
    my_team: str,
    roster_positions: list[dict],
    adp_by_entity: dict[str, int],
) -> float:
    """Section 3: P(a player at `position` survives to the user's next
    turn) = product over every real pick between now and then of
    (1 - that pick's probability of being this position).

    Walked SEQUENTIALLY with running per-team state, not evaluated
    independently per team - required per section 3d, since a team picking
    twice in the same window (the snake round-turn) can have its need
    change between its own two picks. `probable_extra_filled` is a soft,
    expected-value running total (this team's cumulative probability of
    having already taken this position during THIS walk), not a hard
    Monte Carlo sample - simple and cheap, per the spec's explicit "does
    not need to be sophisticated" guidance, while still satisfying the
    correctness requirement that state carries forward within the walk.
    """
    team_order = draft_order.get("team_order", [])
    draft_type = draft_order.get("draft_type", "snake")

    n_until = _picks_until_next_turn(team_order, draft_type, pick_number, my_team)
    if not n_until:
        # No real gap to forecast (already my turn, or draft_order/my_team
        # not configured) - nothing stands between now and "my turn," so
        # survival is certain.
        return 1.0

    team_picks: dict[str, list[dict]] = {t: [p for p in picks if p["team"] == t] for t in team_order}
    probable_extra_filled: dict[str, float] = {t: 0.0 for t in team_order}

    survive_prob = 1.0
    for offset in range(1, n_until + 1):
        pick_n = pick_number + offset
        team = _compute_on_the_clock(team_order, draft_type, pick_n)
        if team is None or team == my_team:
            continue

        slot_fill = _compute_slot_fill(team_picks[team], team, roster_positions)
        starter_capacity = sum(s["open"] for s in _open_starting_slots_for_position(slot_fill, position))
        remaining_capacity = starter_capacity - probable_extra_filled[team]
        has_bench_room = bool(_open_bench_slots_for_position(slot_fill, position))

        if remaining_capacity > 0:
            need_adj = NEED_STARTER
        elif has_bench_room:
            need_adj = NEED_BENCH_ONLY
        else:
            need_adj = NEED_NO_ROOM

        tendency_adj = _tendency_adjustment(team, position, team_picks[team], adp_by_entity)

        rate = _base_rate(position, pick_n, undrafted_players) * need_adj * tendency_adj
        rate = max(0.0, min(1.0, rate))

        survive_prob *= (1 - rate)
        probable_extra_filled[team] += rate

    return survive_prob


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

        undrafted = [p for p in all_players if (p["entity_id"], p["pos"]) not in picked_keys]
        pick_number = len(picks) + 1

        # Survival probability only depends on position, not the specific
        # player - computed once per position (6 total), not once per
        # undrafted player (hundreds), then applied to every player at
        # that position below.
        survival_by_position = {
            pos: _compute_survival_probability(
                pos, pick_number, picks, undrafted, draft_order, my_team, roster_positions, adp_by_entity,
            )
            for pos in POSITIONS
        }
        need_by_position = {
            pos: _need_multiplier(pos, picks, my_team, roster_positions) if my_team else 1.0
            for pos in POSITIONS
        }

        results = []
        for p in undrafted:
            survival = survival_by_position.get(p["pos"], 1.0)
            need = need_by_position.get(p["pos"], 1.0)
            tier_cliff = p["tier_cliff"] or 0.0
            urgency_score = tier_cliff * (1 - survival) * need
            results.append({
                "entity_id": p["entity_id"],
                "pos": p["pos"],
                "draft_score": p["draft_score"],
                "tier": p["tier"],
                "tier_cliff": tier_cliff,
                "survival_probability": round(survival, 4),
                "need_multiplier": need,
                "urgency_score": round(urgency_score, 4),
            })

        results.sort(key=lambda r: r["urgency_score"], reverse=True)
        return _response(200, results)
    except Exception as e:
        log.exception("Failed to compute draft urgency")
        return _response(500, {"error": str(e)})
