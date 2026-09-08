with weekly as (
  select
    r.gsis_id
  , dc.week_id
  , r.status
  , r.full_name
  , r.first_name
  , r.last_name
  , r.position
  , r.birth_date
  , r.height
  , r.weight
  , r.headshot_url
  , r.yahoo_id
  , r.pff_id
  , r.rookie_year
  , dp.round as draft_round
  , COALESCE(dp.pick, r.draft_number) as draft_pick
  , dp.allpro as allpro_selections
  , dp.probowls as probowl_selections
  from read_parquet('${bucket}/silver/rosters/rosters.parquet', union_by_name = true) r
  left outer join read_parquet('${bucket}/silver/draft_picks/draft_picks.parquet', union_by_name = true) dp
    on r.gsis_id = dp.gsis_id
  join read_parquet('${bucket}/gold/dimensions/dim_calendar.parquet') dc
    on r.season = dc.season and r.week = dc.week and r.game_type = dc.game_type
  where COALESCE(r.gsis_id,'') <> ''
),

backfilled as (
  -- draft info is season-invariant per player but sometimes not yet linked
  -- in the source in early weeks - backfill across the player's full
  -- history rather than letting a NULL->value transition look like a
  -- version change. MAX ignores NULLs, and a player only ever has one true
  -- non-null draft slot, so this fills it everywhere.
  select
    w.* exclude (draft_round, draft_pick)
  , max(draft_round) over (partition by gsis_id) as draft_round
  , max(draft_pick) over (partition by gsis_id) as draft_pick
  from weekly w
),

flagged as (
  -- Only genuinely time-varying attributes drive a new version. Static
  -- fields (names, ids, birth_date, backfilled draft info) are carried
  -- along via max() in `collapsed` below rather than checked here, so a
  -- one-week data-quality blip in one of those doesn't fracture the
  -- version history.
  select
    b.*
  , case when
        lag(weight)            over (partition by gsis_id order by week_id) is distinct from weight
     or lag(height)             over (partition by gsis_id order by week_id) is distinct from height
     or lag(headshot_url)       over (partition by gsis_id order by week_id) is distinct from headshot_url
     or lag(allpro_selections)  over (partition by gsis_id order by week_id) is distinct from allpro_selections
     or lag(probowl_selections) over (partition by gsis_id order by week_id) is distinct from probowl_selections
    then 1 else 0 end as is_new_version
  from backfilled b
),

versioned as (
  select
    f.*
  , sum(is_new_version) over (partition by gsis_id order by week_id rows unbounded preceding) as version_id
  from flagged f
),

collapsed as (
  select
    gsis_id
  , max(full_name) as full_name
  , max(first_name) as first_name
  , max(last_name) as last_name
  , max(birth_date) as birth_date
  , max(position) as position
  , weight
  , height
  , headshot_url
  , allpro_selections
  , probowl_selections
  , max(yahoo_id) as yahoo_id
  , max(pff_id) as pff_id
  , max(rookie_year) as rookie_year
  , max(draft_round) as draft_round
  , max(draft_pick) as draft_pick
  , min(week_id) as start_week_id
  , max(week_id) as last_seen_week_id
  from versioned
  group by gsis_id, version_id, weight, height, headshot_url, allpro_selections, probowl_selections
),

ranged as (
  -- end_week_id is exclusive - it equals the next version's start_week_id,
  -- not the last week this version was actually observed. The current
  -- (most recent) version per player has no "next" row yet - whether it
  -- gets left open ('9999-99') or closed off depends on whether the
  -- player is still on the current roster, resolved in the final select
  -- below (needs current_roster, not available yet at this CTE).
  select
    c.*
  , lead(start_week_id) over (partition by gsis_id order by start_week_id) as next_start_week_id
  from collapsed c
),

current_week as (
  select max(week_id) as week_id from weekly
),

current_roster as (
  -- Deliberately NOT part of the SCD history above - these describe "right
  -- now" only, so every version row for a player gets the same current
  -- value rather than this being versioned itself. Grouped/aggregated in
  -- case a player has more than one roster row in the current week (e.g.
  -- practice squad + active entries).
  select
    w.gsis_id
  , true as on_current_roster
  , bool_or(w.status = 'ACT') as on_active_roster
  from weekly w
  join current_week cw on w.week_id = cw.week_id
  group by w.gsis_id
)

select
  r.gsis_id
, r.full_name
, r.first_name
, r.last_name
, r.position
, r.birth_date
, r.weight
, r.height
, r.headshot_url
, r.allpro_selections
, r.probowl_selections
, r.yahoo_id
, r.pff_id
, r.rookie_year
, r.draft_round
, r.draft_pick
, r.start_week_id
, COALESCE(
    r.next_start_week_id,
    -- Last version per player: still open ('9999-99') only if they're on
    -- the current roster. Otherwise (retired/released/not re-signed),
    -- this is the actual last week that version was observed - inclusive,
    -- not the exclusive next-boundary every other row uses, since there
    -- is no "next" row to point to.
    case when cr.on_current_roster then '9999-99' else r.last_seen_week_id end
  ) as end_week_id
-- current_roster is keyed only by gsis_id, so without this guard every
-- historical version row for a still-rostered player would show these as
-- true, not just their current version. Only the open/most-recent version
-- (no next_start_week_id) can ever be true; every earlier version is
-- unconditionally false, regardless of the player's actual current status.
, r.next_start_week_id is null and COALESCE(cr.on_current_roster, false) as on_current_roster
, r.next_start_week_id is null and COALESCE(cr.on_active_roster, false) as on_active_roster
from ranged r
left outer join current_roster cr
  on r.gsis_id = cr.gsis_id
order by r.gsis_id, r.start_week_id