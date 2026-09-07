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


def _config_key(name: str) -> str:
    return f"config/{name}.json"


def _handle_get(name: str) -> dict:
    try:
        obj = s3.get_object(Bucket=BUCKET_NAME, Key=_config_key(name))
        return _response(200, json.loads(obj["Body"].read()))
    except s3.exceptions.NoSuchKey:
        # Nothing saved yet (first run, before any admin save) - the
        # registry's default, not an error, so the admin UI has something
        # sane to render a form around.
        return _response(200, CONFIG_REGISTRY[name]["default"])


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
