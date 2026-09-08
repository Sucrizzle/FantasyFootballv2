"""
Config.py

One generic Lambda for every admin-editable config value (scoring point
values, team size, and whatever else surfaces - see
docs/project-summary.md's "Scoring is heavily parameterized" section).
Each named config is a small JSON blob in S3, read/written via a `{name}`
path parameter rather than one Lambda + one pair of API Gateway routes per
config type.

Deliberately one Lambda, not one per config: every Lambda in this project
needs a full round of manual AWS console setup (function, execution role,
two API Gateway routes, fixing the default Handler string) - see
Bronze/Silver/Gold/ScoringConfig for that whole checklist repeated each
time. With config values still being discovered ("scoring, team size,
etc."), paying that setup cost once and making a new config type a code
change (add a CONFIG_REGISTRY entry) rather than new infrastructure is
the better trade for a ~1-month timeline. The cost: one execution role
covering all of "config/*" rather than scoped per item, and a bug in the
dispatch logic below can affect every config type at once. Both are fine
tradeoffs for low-risk, admin-only settings.

Supersedes ScoringConfig.py, which was CSV-shaped and specific to the
scoring category/points list - fine for that one shape, awkward for
something like team size (a single scalar). Every config here is stored
as JSON instead (config/<name>.json) so gold queries needing one read it
via `read_json`, same idea as ScoringConfig.py's `read_csv` but general
enough for any shape.

Deliberately NOT alongside Datasets/Mappings/*.csv, and NOT wired into
the CI/CD "Upload Mapping Files" step - see ScoringConfig.py's original
reasoning, unchanged here: these are mutable *application* state written
only through this Lambda's PUT handler, not static files owned by git.

No async entry/worker split - reading or writing one small JSON blob is
fast, nowhere near API Gateway's ~30s integration timeout.

Expected API Gateway (Lambda proxy) routes, both with the Cognito JWT
authorizer attached:
    GET /config/{name}
        -> 200 <whatever JSON is stored for that name, or the registry's
                default if nothing's been saved yet>
    PUT /config/{name}
        body: <shape depends on `name` - see CONFIG_REGISTRY below>
        -> 200 {"message": "..."}

Adding a new config type: add an entry to CONFIG_REGISTRY with a
`validate(body) -> (cleaned_value, error_message)` function and a
`default` value. No other code changes needed.

Deploy notes:
    - Runtime: Python 3.12+, boto3 only - no layer needed.
    - Execution role: needs s3:GetObject + s3:PutObject scoped to
      "config/*" on the bucket - nothing else.
    - Set the BUCKET_NAME environment variable - differs between dev and
      prod deploys of this same code.
    - Timeout: short (10-15s) is plenty.
"""

import json
import logging
import os

import boto3

BUCKET_NAME = os.environ["BUCKET_NAME"]
ADMIN_GROUP = "admin"

log = logging.getLogger(__name__)
log.setLevel(logging.INFO)

s3 = boto3.client("s3")


def _validate_scoring(body: dict) -> tuple[dict | None, str | None]:
    categories = body.get("categories")
    if not isinstance(categories, list) or not categories:
        return None, "`categories` must be a non-empty list."

    seen = set()
    for row in categories:
        if not isinstance(row, dict) or "category" not in row or "points" not in row:
            return None, "Each entry needs a `category` (string) and `points` (number)."
        if not isinstance(row["category"], str) or not row["category"].strip():
            return None, "`category` must be a non-empty string."
        try:
            float(row["points"])
        except (TypeError, ValueError):
            return None, f"`points` for '{row['category']}' must be a number."
        if row["category"] in seen:
            return None, f"Duplicate category '{row['category']}'."
        seen.add(row["category"])

    return {"categories": categories}, None


def _validate_teams(body: dict) -> tuple[dict | None, str | None]:
    teams = body.get("teams")
    if not isinstance(teams, list) or not (2 <= len(teams) <= 32):
        return None, "`teams` must be a list of between 2 and 32 team names."

    seen = set()
    for team_name in teams:
        if not isinstance(team_name, str) or not team_name.strip():
            return None, "Each team name must be a non-empty string."
        if team_name in seen:
            return None, f"Duplicate team name '{team_name}'."
        seen.add(team_name)

    return {"teams": teams}, None


def _validate_draft_order(body: dict) -> tuple[dict | None, str | None]:
    draft_type = body.get("draft_type")
    if draft_type not in ("snake", "round_robin"):
        return None, "`draft_type` must be 'snake' or 'round_robin'."

    team_order = body.get("team_order")
    if not isinstance(team_order, list):
        return None, "`team_order` must be a list."

    current_teams = _read_config("teams").get("teams", [])
    if sorted(team_order) != sorted(current_teams):
        return None, "`team_order` must contain exactly the teams in the current Teams config, each once."

    return {"draft_type": draft_type, "team_order": team_order}, None


def _validate_roster_positions(body: dict) -> tuple[dict | None, str | None]:
    slots = body.get("slots")
    if not isinstance(slots, list) or not slots:
        return None, "`slots` must be a non-empty list."

    seen = set()
    for row in slots:
        if not isinstance(row, dict) or "slot_name" not in row or "count" not in row or "eligible_positions" not in row:
            return None, "Each slot needs `slot_name`, `count`, and `eligible_positions`."
        if not isinstance(row["slot_name"], str) or not row["slot_name"].strip():
            return None, "`slot_name` must be a non-empty string."
        if not isinstance(row["count"], int) or isinstance(row["count"], bool) or row["count"] < 1:
            return None, f"`count` for '{row['slot_name']}' must be a positive integer."
        positions = row["eligible_positions"]
        if not isinstance(positions, list) or not positions or not all(isinstance(p, str) and p.strip() for p in positions):
            return None, f"`eligible_positions` for '{row['slot_name']}' must be a non-empty list of position strings."
        if row["slot_name"] in seen:
            return None, f"Duplicate slot name '{row['slot_name']}'."
        seen.add(row["slot_name"])

    return {"slots": slots}, None


def _validate_k_values(body: dict) -> tuple[dict | None, str | None]:
    values = body.get("values")
    if not isinstance(values, list) or not values:
        return None, "`values` must be a non-empty list."

    seen = set()
    for row in values:
        if not isinstance(row, dict) or "position" not in row or "k_value" not in row:
            return None, "Each entry needs a `position` (string) and `k_value` (number)."
        if not isinstance(row["position"], str) or not row["position"].strip():
            return None, "`position` must be a non-empty string."
        try:
            float(row["k_value"])
        except (TypeError, ValueError):
            return None, f"`k_value` for '{row['position']}' must be a number."
        if row["position"] in seen:
            return None, f"Duplicate position '{row['position']}'."
        seen.add(row["position"])

    return {"values": values}, None


def _config_key(name: str) -> str:
    return f"config/{name}.json"


def _read_config(name: str) -> dict:
    """Reads a named config's current value, falling back to its registry
    default if nothing's been saved yet. Shared by _handle_get and any
    validator that needs to check against another config's value (e.g.
    my_team/draft_order needing the current `teams` list)."""
    try:
        obj = s3.get_object(Bucket=BUCKET_NAME, Key=_config_key(name))
        return json.loads(obj["Body"].read())
    except s3.exceptions.NoSuchKey:
        return CONFIG_REGISTRY[name]["default"]


def _validate_my_team(body: dict) -> tuple[dict | None, str | None]:
    team_name = body.get("team_name")
    if not isinstance(team_name, str) or not team_name.strip():
        return None, "`team_name` must be a non-empty string."

    current_teams = _read_config("teams").get("teams", [])
    if team_name not in current_teams:
        return None, f"'{team_name}' isn't in the current teams list - add it under the Teams config first."

    return {"team_name": team_name}, None


def _validate_flex_shares(body: dict) -> tuple[dict | None, str | None]:
    shares = body.get("shares")
    if not isinstance(shares, list):
        return None, "`shares` must be a list."

    current_slots = {
        s["slot_name"]: s["eligible_positions"]
        for s in _read_config("roster_positions").get("slots", [])
    }

    totals: dict[str, float] = {}
    seen = set()
    for row in shares:
        if not isinstance(row, dict) or "slot_name" not in row or "position" not in row or "share_pct" not in row:
            return None, "Each entry needs `slot_name`, `position`, and `share_pct`."

        slot_name, position = row["slot_name"], row["position"]
        if slot_name not in current_slots:
            return None, f"'{slot_name}' isn't in the current Roster Positions config."
        if position not in current_slots[slot_name]:
            return None, f"'{position}' isn't an eligible position for slot '{slot_name}'."

        try:
            share_pct = float(row["share_pct"])
        except (TypeError, ValueError):
            return None, f"`share_pct` for '{slot_name}'/'{position}' must be a number."
        if not (0 <= share_pct <= 1):
            return None, f"`share_pct` for '{slot_name}'/'{position}' must be between 0 and 1."

        key = (slot_name, position)
        if key in seen:
            return None, f"Duplicate entry for slot '{slot_name}', position '{position}'."
        seen.add(key)
        totals[slot_name] = totals.get(slot_name, 0) + share_pct

    # Every multi-position slot's shares must fully account for its one
    # count - a slot whose shares sum to less than 1 would silently shrink
    # its own replacement-rank contribution, and more than 1 would inflate
    # it, in fact_draft_scores.sql's off_position_slot_count.
    for slot_name, total in totals.items():
        if abs(total - 1.0) > 0.001:
            return None, f"Shares for slot '{slot_name}' must sum to 1.0 (currently {total:.3f})."

    return {"shares": shares}, None


# Adding a new config type is just adding an entry here - `validate` checks
# and normalizes a PUT body, `default` is what GET returns before anyone's
# ever saved a value for that name.
CONFIG_REGISTRY = {
    "scoring": {
        "validate": _validate_scoring,
        "default": {"categories": []},
    },
    "teams": {
        "validate": _validate_teams,
        # League size is derived from len(teams) rather than tracked as a
        # separate number - this list IS the source of truth for both the
        # roster of teams the draft board needs and how many there are.
        "default": {"teams": []},
    },
    "my_team": {
        "validate": _validate_my_team,
        # Which entry in `teams` is the app's own user - MVP1 is
        # single-user (see docs/project-summary.md), so this is a single
        # value, not a per-user mapping. Validated against the current
        # `teams` config rather than accepted as an arbitrary string, so
        # it can't silently drift from an actual team in the league.
        "default": {"team_name": None},
    },
    "draft_order": {
        "validate": _validate_draft_order,
        # team_order is round-1 order regardless of draft_type - "snake"
        # means the order reverses each subsequent round, "round_robin"
        # means every round uses this same order. Whatever computes "picks
        # until my next turn" needs both draft_type and team_order plus
        # the current pick number - deliberately not stored here, since
        # that's live draft state, not config.
        "default": {"draft_type": "snake", "team_order": []},
    },
    "roster_positions": {
        "validate": _validate_roster_positions,
        # FLEX/SUPERFLEX aren't special-cased anywhere - they're just a
        # slot whose eligible_positions has more than one entry. A normal
        # RB slot is eligible_positions=["RB"]; FLEX is
        # eligible_positions=["RB","WR","TE"]; SUPERFLEX adds "QB" to that
        # list. Whatever reads this (the draft-need heuristic on the
        # frontend) just checks "is this player's position in this slot's
        # eligible_positions", the same check regardless of slot type.
        "default": {"slots": [
            {"slot_name": "QB", "count": 1, "eligible_positions": ["QB"]},
            {"slot_name": "RB", "count": 2, "eligible_positions": ["RB"]},
            {"slot_name": "WR", "count": 2, "eligible_positions": ["WR"]},
            {"slot_name": "TE", "count": 1, "eligible_positions": ["TE"]},
            {"slot_name": "FLEX", "count": 1, "eligible_positions": ["RB", "WR", "TE"]},
            {"slot_name": "DST", "count": 1, "eligible_positions": ["DST"]},
            {"slot_name": "K", "count": 1, "eligible_positions": ["K"]},
            {"slot_name": "BENCH", "count": 6, "eligible_positions": ["QB", "RB", "WR", "TE", "DST", "K"]},
        ]},
    },
    "k_values": {
        "validate": _validate_k_values,
        # Per-position shrinkage constant for blending a limited-history or
        # rookie player's own (thin) stats with the dim_rookie_baseline
        # lookup - see docs/draft-score-calculation-map-spec.md. Unrelated
        # to the K/kicker position despite the name collision - "k" here is
        # the shrinkage formula's weighting constant.
        "default": {"values": []},
    },
    "flex_shares": {
        "validate": _validate_flex_shares,
        # How a multi-eligible-position slot's count is apportioned across
        # the positions it's eligible for when computing each position's
        # replacement rank - see docs/draft-score-calculation-map-spec.md.
        # A single FLEX slot isn't "one full slot" for RB, WR, and TE all
        # at once; it's one slot that gets used for whichever position
        # wins out, apportioned here by expected usage share. Dedicated
        # single-position slots (QB, RB, ...) don't need an entry at all -
        # only slots with more than one eligible position (FLEX,
        # SUPERFLEX) do.
        "default": {"shares": []},
    },
}


def _response(status_code: int, body: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def _is_admin(event: dict) -> bool:
    # Same claim-parsing logic as Bronze/Silver/Gold/ScoringConfig - see
    # those files for why this specific shape (HTTP API's JWT authorizer
    # serializes array claims as a bracket-wrapped, comma-separated,
    # NON-json-quoted string like "[admin]", not valid JSON).
    authorizer = event.get("requestContext", {}).get("authorizer", {})
    claims = authorizer.get("jwt", {}).get("claims", {}) or authorizer.get("claims", {})
    groups = claims.get("cognito:groups", "")

    if isinstance(groups, list):
        return ADMIN_GROUP in groups
    if groups.startswith("[") and groups.endswith("]"):
        members = [g.strip() for g in groups[1:-1].split(",") if g.strip()]
        return ADMIN_GROUP in members
    return ADMIN_GROUP in groups.split(",")


def _handle_get(name: str) -> dict:
    return _response(200, _read_config(name))


def _handle_put(name: str, event: dict) -> dict:
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "Invalid JSON body."})

    cleaned, error = CONFIG_REGISTRY[name]["validate"](body)
    if error:
        return _response(400, {"error": error})

    s3.put_object(
        Bucket=BUCKET_NAME,
        Key=_config_key(name),
        Body=json.dumps(cleaned).encode("utf-8"),
    )
    log.info(f"Wrote config '{name}' -> s3://{BUCKET_NAME}/{_config_key(name)}")
    return _response(200, {"message": f"'{name}' config saved."})


def handler(event, context):
    if not _is_admin(event):
        return _response(403, {"error": "Admin access required."})

    name = (event.get("pathParameters") or {}).get("name")
    if name not in CONFIG_REGISTRY:
        return _response(404, {"error": f"Unknown config '{name}'."})

    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    if method == "PUT":
        return _handle_put(name, event)

    return _handle_get(name)
