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
),

off_season as (
  select ss.season, ss.gsis_id, dp.position, ss.fpts_pg
  from read_parquet('${bucket}/gold/facts/fact_player_stats_season.parquet', union_by_name = true) ss
  join read_parquet('${bucket}/gold/dimensions/dim_player.parquet', union_by_name = true) dp
    on ss.gsis_id = dp.gsis_id
  where game_category = 'Regular Season'
    and dp.end_week_id = '9999-99'
),

off_most_recent_completed as (
  -- Exclude the current season if it's still in progress - a partial
  -- season shouldn't anchor "seasons ago" math or get treated as a full
  -- data point yet.
  select max(season) as season 
  from off_season where season < (select max(season) from '${bucket}/gold/dimensions/dim_calendar.parquet')
),

off_weighted as (
	SELECT
	  os.gsis_id
	, os.season
	, os.position
	, os.fpts_pg
	, power(0.60, (m.season - os.season)) as weight
	FROM off_season os
	CROSS JOIN off_most_recent_completed m
	WHERE os.season <= m.season
),

off_proj_fpts_pg as (
	select
	  gsis_id
	, position
	, try_cast(sum(fpts_pg * weight) / sum(weight) as decimal(10,2)) as proj_fpts_pg
	from off_weighted
	group by gsis_id, position
),

off_slot_count as (
  select 
    slot_name
  , sum(count) as slots_per_team
  from roster_positions
  where list_has_any(eligible_positions, ['QB', 'WR', 'RB', 'TE'])
    and slot_name != 'BENCH'
  group by 1
),

off_replacement_rank as (
  select o.slot_name, o.slots_per_team * l.team_count as rank_position
  from off_slot_count o
  cross join league_size l
),

off_ranked as (
  select
    gsis_id
  , position
  , proj_fpts_pg
  , row_number() over (partition by position order by proj_fpts_pg desc) as rnk
  from off_proj_fpts_pg
),

off_replacement_level as (
  select off_ranked.position, off_ranked.proj_fpts_pg as r_fpts_pg
  from off_ranked
  join off_replacement_rank
    on off_ranked.position = off_replacement_rank.slot_name
   and off_ranked.rnk = off_replacement_rank.rank_position
)

select
  r.team as entity_id
, 'DST' as pos
, r.proj_fpts_pg
, rl.r_fpts_pg
, try_cast(r.proj_fpts_pg - rl.r_fpts_pg as decimal(10,2)) as draft_score
from dst_ranked r
cross join dst_replacement_level rl
union all
select
  r.gsis_id as entity_id
, r.position as pos
, r.proj_fpts_pg
, rl.r_fpts_pg
, try_cast(r.proj_fpts_pg - rl.r_fpts_pg as decimal(10,2)) as draft_score
from off_ranked r
join off_replacement_level rl
  on r.position = rl.position