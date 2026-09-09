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

# See handler()'s urgency_score assembly - encodes "tier is the dominant
# sort key, raw urgency is the tie-breaker" as a hard property of the
# number itself. TIER_DOMINANCE_SCALE must stay comfortably above any
# realistic raw_urgency value (observed well under 100 in testing).
# MAX_TIER_BOUND is a safe ceiling above any real number of tiers a
# position could have, so lower (better) tier numbers always win.
TIER_DOMINANCE_SCALE = 10000
MAX_TIER_BOUND = 20

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
        , fds.proj_fpts_pg
        , fds.draft_score
        , fds.tier
        , fds.tier_size
        , fds.tier_gap
        , adp.ADP as adp_rank
        from read_parquet('{bucket_uri}/gold/facts/fact_draft_scores.parquet', union_by_name = true) fds
        left outer join read_parquet('{bucket_uri}/gold/facts/fact_adp.parquet', union_by_name = true) adp
          on fds.entity_id = adp.entity_id
    """).fetchall()

    columns = ["entity_id", "pos", "proj_fpts_pg", "draft_score", "tier", "tier_size", "tier_gap", "adp_rank"]
    players = []
    for row in rows:
        rec = dict(zip(columns, row))
        for key in ("proj_fpts_pg", "draft_score", "tier_gap"):
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


def _compute_position_pick_forecast(
    position: str,
    pick_number: int,
    picks: list[dict],
    undrafted_players: list[dict],
    draft_order: dict,
    my_team: str,
    roster_positions: list[dict],
    adp_by_entity: dict[str, int],
) -> tuple[float, float]:
    """Section 3, generalized: walks the picks between now and the user's
    next turn and returns (survive_prob, expected_picks) for `position` -
    survive_prob is P(nobody takes this position at all) on its own;
    expected_picks is the sum of per-pick rates, i.e. the expected NUMBER
    of this-position picks before the user's turn. _player_survival_
    probability below turns expected_picks into a genuinely per-PLAYER
    number by comparing it against a specific player's own rank at the
    position - this function only computes the position-level forecast
    once (shared across every player at that position), not once per
    player.

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
        # survival is certain and nobody's expected to be picked.
        return 1.0, 0.0

    team_picks: dict[str, list[dict]] = {t: [p for p in picks if p["team"] == t] for t in team_order}
    probable_extra_filled: dict[str, float] = {t: 0.0 for t in team_order}

    # n_until picks separate now from my next turn - that's pick_number
    # itself (whoever's on the clock RIGHT NOW) through pick_number +
    # n_until - 1, since pick_number + n_until is my own turn (that's
    # literally how _picks_until_next_turn found n_until). Starting the
    # walk at pick_number + 1 instead of pick_number was a real bug: it
    # silently skipped the very next pick every time, which is invisible
    # when n_until is large (one missed pick out of many) but total when
    # n_until == 1 - the walk's only "iteration" would land on my own turn,
    # get correctly skipped as not-a-threat, and leave zero picks
    # evaluated at all, defaulting every survival_probability to 1.0 and
    # every urgency_score to 0.00 - exactly the reported bug ("every time
    # the team before is on the board, urgency is 0.00").
    survive_prob = 1.0
    expected_picks = 0.0
    for offset in range(0, n_until):
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
        expected_picks += rate
        probable_extra_filled[team] += rate

    return survive_prob, expected_picks


def _player_survival_probability(candidate: dict, position_pool: list[dict], expected_picks: float) -> float:
    """P(this specific player - or, equivalently, nobody at least this
    good - survives to the user's next turn). Reframes the position-level
    expected_picks against THIS player's own rank among currently
    undrafted players at their position: if expected_picks is much smaller
    than how many players rank ahead of (or at) this one, survival is
    likely; if expected_picks meets or exceeds that rank, it isn't. This
    is what makes survival tier-sensitive without a separate tier-specific
    walk - a player near the top of the position needs very few picks to
    be at risk, a player deep down the board needs many, using the exact
    same position-level forecast either way."""
    same_position = sorted(
        (p for p in position_pool if p["pos"] == candidate["pos"]),
        key=lambda p: -(p["draft_score"] or 0),
    )
    rank = next(
        (i + 1 for i, p in enumerate(same_position) if p["entity_id"] == candidate["entity_id"]),
        len(same_position) or 1,
    )
    return max(0.0, min(1.0, 1 - expected_picks / rank))


def _live_tier_cliff(candidate: dict, undrafted_players: list[dict]) -> float:
    """tier_gap (this tier's average draft_score minus the next tier's -
    genuinely static, computed once in Gold) scaled by TWO live, blended
    signals, recomputed fresh every call:

    1. fraction_depleted - how much of this player's ORIGINAL tier
       (Gold's static tier_size) has already been drafted away. Starts at
       0 for an untouched tier and climbs toward 1.0 as the tier empties
       out - this is what makes exposure rise as tier-mates get taken,
       which rank-within-remaining-tier alone doesn't reliably do (it can
       actually DIP for a player who becomes the top of a still-mostly-
       intact tier, since they picked up buffer even though the tier
       shrank - see chat).
    2. rank_within_remaining_tier - where this player sits among
       CURRENTLY UNDRAFTED tier-mates specifically, preserving the
       original "does this player personally have a buffer below them"
       distinction (points 4+5 of the redesign).

    Neither alone was right: fraction_depleted alone would give every
    remaining player in a tier the identical value, losing the "where do
    I fit" signal; rank-within-remaining-tier alone could dip as a tier
    thins out from the top. Multiplying them keeps both properties.
    """
    tier_gap = candidate["tier_gap"]
    original_tier_size = candidate["tier_size"]
    if candidate["tier"] is None or tier_gap is None or not original_tier_size:
        return 0.0

    same_tier_undrafted = sorted(
        (p for p in undrafted_players if p["pos"] == candidate["pos"] and p["tier"] == candidate["tier"]),
        key=lambda p: -(p["draft_score"] or 0),
    )
    remaining_tier_size = len(same_tier_undrafted)
    if remaining_tier_size == 0:
        return tier_gap  # candidate is somehow the last one - full exposure

    rank = next(
        (i + 1 for i, p in enumerate(same_tier_undrafted) if p["entity_id"] == candidate["entity_id"]),
        remaining_tier_size,
    )
    fraction_depleted = max(0.0, (original_tier_size - remaining_tier_size) / original_tier_size)
    rank_fraction = rank / remaining_tier_size
    return tier_gap * fraction_depleted * rank_fraction


def _optimal_lineup_ppg(players: list[dict], roster_positions: list[dict]) -> float:
    """Greedy value-maximizing lineup assignment: highest proj_fpts_pg
    gets first claim on the most specific still-open eligible slot (same
    iteration order as _compute_slot_fill, but by value instead of draft
    order), summing PPG across non-BENCH assignments only - bench players
    don't score for you, so they don't count toward team PPG."""
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


def _net_ppg_impact(candidate: dict, my_players: list[dict], roster_positions: list[dict]) -> float:
    """Sections 1+2 combined: how much does MY optimal starting lineup's
    total PPG change if I add this player, given my ACTUAL current roster
    - not a generic "is this a need" flag. A redundant position naturally
    comes out near zero here (the candidate just displaces nobody and ends
    up on the bench) without needing a separate need_multiplier at all."""
    without = _optimal_lineup_ppg(my_players, roster_positions)
    with_candidate = _optimal_lineup_ppg(my_players + [candidate], roster_positions)
    return with_candidate - without


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

        # The position-level pick forecast (survive_prob is kept only for
        # API transparency/troubleshooting; expected_picks is what actually
        # feeds _player_survival_probability below) is shared across every
        # undrafted player at that position - computed once per position
        # (6 total), not once per player (hundreds).
        forecast_by_position = {
            pos: _compute_position_pick_forecast(
                pos, pick_number, picks, undrafted, draft_order, my_team, roster_positions, adp_by_entity,
            )
            for pos in POSITIONS
        }

        # My own current roster, with each pick's proj_fpts_pg looked up -
        # needed as the baseline _net_ppg_impact compares "with candidate"
        # against. Picks only carry entity_id/pos/team from DynamoDB, not
        # proj_fpts_pg, so this joins them against the same static player
        # data everything else here uses.
        players_by_key = {(p["entity_id"], p["pos"]): p for p in all_players}
        my_players = []
        if my_team:
            for pick in picks:
                if pick["team"] != my_team:
                    continue
                player = players_by_key.get((pick["entity_id"], pick["pos"]))
                my_players.append({"pos": pick["pos"], "proj_fpts_pg": player["proj_fpts_pg"] if player else 0})

        results = []
        for p in undrafted:
            survival_prob, expected_picks = forecast_by_position.get(p["pos"], (1.0, 0.0))
            player_survival = _player_survival_probability(p, undrafted, expected_picks)
            net_impact = _net_ppg_impact(p, my_players, roster_positions) if my_team else 0.0
            tier_cliff = _live_tier_cliff(p, undrafted)

            # Three distinct, complementary factors: net_impact is how much
            # drafting them helps MY team right now (folds in "is this a
            # need" - a redundant position naturally nets ~0 here); (1 -
            # player_survival) is how likely I am to lose access to a
            # player this good if I wait; tier_cliff is how much worse my
            # fallback would be if that actually happens. See chat
            # (docs/realtime-urgency-scoring-spec.md's replacement).
            raw_urgency = net_impact * (1 - player_survival) * tier_cliff

            # A tier 4 player must never outrank a tier 3 player at the
            # same position, full stop - not just "usually," since these
            # three factors could otherwise combine in surprising ways.
            # Encoding tier as the dominant term and raw_urgency as a
            # tie-breaker (same technique as a lexicographic sort packed
            # into one sortable number) makes that a hard mathematical
            # property of urgency_score itself, which matters because the
            # frontend table re-sorts on this raw number whenever someone
            # clicks the column header - a display-only ordering wouldn't
            # survive that. TIER_DOMINANCE_SCALE is comfortably above any
            # realistic raw_urgency magnitude observed in testing (well
            # under 100), so it can never cross a tier boundary. Untiered
            # players (outside the top-2x-replacement window Gold tiers at
            # all) are treated as worse than every real tier.
            tier_for_ranking = p["tier"] if p["tier"] is not None else MAX_TIER_BOUND
            urgency_score = (MAX_TIER_BOUND - tier_for_ranking) * TIER_DOMINANCE_SCALE + raw_urgency

            results.append({
                "entity_id": p["entity_id"],
                "pos": p["pos"],
                "draft_score": p["draft_score"],
                "tier": p["tier"],
                "tier_cliff": tier_cliff,
                "position_survival_probability": round(survival_prob, 4),
                "survival_probability": round(player_survival, 4),
                "net_ppg_impact": round(net_impact, 2),
                "raw_urgency": round(raw_urgency, 4),
                "urgency_score": round(urgency_score, 4),
            })

        results.sort(key=lambda r: r["urgency_score"], reverse=True)
        return _response(200, results)
    except Exception as e:
        log.exception("Failed to compute draft urgency")
        return _response(500, {"error": str(e)})
