"""
DraftState.py

Tracks the live draft: the list of picks made so far. Everything else a
draft-night UI needs - whose turn is next, what's still available, what's
on your own roster - is *derived* from this one list plus config you
already have (draft_order, teams, roster_positions), not stored here.

DynamoDB, not S3/Config.py, deliberately - see chat. The other configs
(scoring, teams, roster_positions, draft_order) are edited rarely, whole-
document replace, no real risk if two edits overlap. Draft state gets a
new write on every single pick, potentially dozens in rapid succession
during a live draft, and this is a one-shot, high-stakes event for the
night - a lost pick from a read-modify-write race (the pattern Config.py
uses) would actually hurt, unlike a config mistake you can just re-save.
DynamoDB's conditional writes give an actual guarantee against that.

Data model: one DynamoDB item PER PICK, not one item holding a growing
list - table `fantasy-football-draft-state-dev`, partition key
`pick_number` (Number), attributes `team`, `entity_id`, `pos`. Recording a
pick is a PutItem with ConditionExpression attribute_not_exists(pick_number) -
this can't silently overwrite an existing pick or double-record the same
pick_number, unlike an append to a list attribute. Reading the whole draft
state is a Scan - trivial and fast at at most a couple hundred items for a
full draft.

No admin gating - unlike Bronze/Silver/Gold/Config, every authenticated
user should be able to record/view picks, not just admins. API Gateway's
Cognito JWT authorizer already confirms the caller is signed in.

No async job pattern - every operation here is a fast, small DynamoDB
call, nowhere near API Gateway's ~30s integration timeout.

Expected API Gateway (Lambda proxy) routes, all with the Cognito JWT
authorizer attached:
    GET /draft-state
        -> 200 [{"pick_number": 1, "team": "...", "entity_id": "...", "pos": "..."}, ...]
        (sorted by pick_number ascending)
    POST /draft-state
        body: {"team": "...", "entity_id": "...", "pos": "..."}
        -> 201 {"pick_number": <computed>, "team": "...", "entity_id": "...", "pos": "..."}
        pick_number is computed server-side (current max + 1), not
        supplied by the caller - avoids an entire class of gap/mismatch
        bugs from the client guessing wrong.
    DELETE /draft-state/{pick_number}
        -> 200 {"message": "..."}
        Undo support - mis-clicks happen live, and there's no reason a
        correction should require going around this API.

Deploy notes:
    - Runtime: Python 3.12+, boto3 only (included in the base runtime) -
      no layer needed, same as Config.py.
    - Execution role: needs dynamodb:GetItem/PutItem/DeleteItem/Scan
      scoped to the draft-state table ARN, PLUS s3:GetObject scoped to
      "config/teams.json" (to validate the team name on a POST).
    - Set the BUCKET_NAME and DRAFT_STATE_TABLE_NAME environment
      variables - differ between dev and prod deploys of this same code.
    - Timeout: short (10-15s) is plenty.
"""

import json
import logging
import os

import boto3
from boto3.dynamodb.conditions import Attr

BUCKET_NAME = os.environ["BUCKET_NAME"]
DRAFT_STATE_TABLE_NAME = os.environ["DRAFT_STATE_TABLE_NAME"]
TEAMS_CONFIG_KEY = "config/teams.json"

log = logging.getLogger(__name__)
log.setLevel(logging.INFO)

s3 = boto3.client("s3")
draft_state_table = boto3.resource("dynamodb").Table(DRAFT_STATE_TABLE_NAME)


def _response(status_code: int, body) -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def _valid_teams() -> list[str]:
    try:
        obj = s3.get_object(Bucket=BUCKET_NAME, Key=TEAMS_CONFIG_KEY)
        return json.loads(obj["Body"].read()).get("teams", [])
    except s3.exceptions.NoSuchKey:
        return []


def _handle_get() -> dict:
    items = draft_state_table.scan().get("Items", [])
    items.sort(key=lambda i: int(i["pick_number"]))
    return _response(200, items)


def _handle_post(event: dict) -> dict:
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "Invalid JSON body."})

    team = body.get("team")
    entity_id = body.get("entity_id")
    pos = body.get("pos")

    if not team or not entity_id or not pos:
        return _response(400, {"error": "`team`, `entity_id`, and `pos` are all required."})

    if team not in _valid_teams():
        return _response(400, {"error": f"'{team}' isn't in the current teams list."})

    existing = draft_state_table.scan().get("Items", [])

    already_picked = any(i["entity_id"] == entity_id and i["pos"] == pos for i in existing)
    if already_picked:
        return _response(400, {"error": f"{pos} '{entity_id}' has already been picked."})

    # Server-computed, not caller-supplied - the caller can't get this
    # wrong or race against another submission guessing the same number.
    next_pick_number = max((int(i["pick_number"]) for i in existing), default=0) + 1

    item = {
        "pick_number": next_pick_number,
        "team": team,
        "entity_id": entity_id,
        "pos": pos,
    }

    try:
        draft_state_table.put_item(
            Item=item,
            ConditionExpression=Attr("pick_number").not_exists(),
        )
    except draft_state_table.meta.client.exceptions.ConditionalCheckFailedException:
        # Someone else's write landed on the same pick_number between our
        # scan and this put - extremely unlikely for a single-user, one-
        # click-at-a-time UI, but this is exactly the race the DynamoDB
        # design (vs. Config.py's read-modify-write) exists to catch
        # loudly instead of silently dropping a pick.
        return _response(409, {"error": "Pick number conflict - try again."})

    return _response(201, item)


def _handle_delete(event: dict) -> dict:
    pick_number = (event.get("pathParameters") or {}).get("pick_number")
    if not pick_number:
        return _response(400, {"error": "Missing pick_number."})

    try:
        pick_number = int(pick_number)
    except ValueError:
        return _response(400, {"error": "`pick_number` must be an integer."})

    draft_state_table.delete_item(Key={"pick_number": pick_number})
    return _response(200, {"message": f"Pick {pick_number} removed."})


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")

    if method == "POST":
        return _handle_post(event)
    if method == "DELETE":
        return _handle_delete(event)

    return _handle_get()
