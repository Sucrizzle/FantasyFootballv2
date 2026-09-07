with roster_positions as (
  select unnest(slots, recursive := true)
  from read_json('${bucket}/config/roster_positions.json')
),

league_size as (
  select len(teams) as team_count
  from read_json('${bucket}/config/teams.json')
),

dst_season as (
  select season, team, fpts_pg
  from read_parquet('${bucket}/gold/facts/fact_team_stats_season.parquet', union_by_name = true)
  where game_category = 'Regular Season'
),

dst_most_recent_completed as (
  -- Exclude the current season if it's still in progress - a partial
  -- season shouldn't anchor "seasons ago" math or get treated as a full
  -- data point yet.
  select max(season) as season 
  from dst_season where season < (select max(season) from '${bucket}/gold/dimensions/dim_calendar.parquet')
),

dst_weighted as (
  select
    d.team
  , d.season
  , d.fpts_pg
  , power(0.60, (m.season - d.season)) as weight
  from dst_season d
  cross join dst_most_recent_completed m
  where d.season <= m.season
),

dst_proj_fpts_pg as (
	select
	  team
	, try_cast(sum(fpts_pg * weight) / sum(weight) as decimal(10,2)) as proj_fpts_pg
	from dst_weighted
	group by team
),

dst_slot_count as (
  select sum(count) as slots_per_team
  from roster_positions
  where list_contains(eligible_positions, 'DST')
    and slot_name != 'BENCH'
),

dst_replacement_rank as (
  select d.slots_per_team * l.team_count as rank_position
  from dst_slot_count d
  cross join league_size l
),

dst_ranked as (
  select
    team
  , proj_fpts_pg
  , row_number() over (order by proj_fpts_pg desc) as rnk
  from dst_proj_fpts_pg
),

dst_replacement_level as (
  select dst_ranked.proj_fpts_pg as r_fpts_pg
  from dst_ranked, dst_replacement_rank
  where dst_ranked.rnk = dst_replacement_rank.rank_position
)

select
  r.team as entity_id
, 'DST' as pos
, r.proj_fpts_pg
, rl.r_fpts_pg
, try_cast(r.proj_fpts_pg - rl.r_fpts_pg as decimal(10,2)) as draft_score
from dst_ranked r
cross join dst_replacement_level rl