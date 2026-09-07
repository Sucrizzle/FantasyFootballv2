with raw_stats as (
  select
    s.season || '-' || RIGHT('0' || s.week,2) as week_id
  , s.season || '-' || RIGHT('0' || s.week,2) || '-' || s.away_team || '-' || s.home_team as game_id
  , 'Home' as team_category
  , s.home_team as team
  , s.home_score as score
  , ts.completions as comp
  , ts.attempts as att
  , cast((ts.completions / ts.attempts) * 100 as decimal(10,2)) as comp_pct
  , ts.passing_yards as pass_yd
  , ts.passing_tds as pass_td
  , ts.passing_interceptions as int_thrown
  , ts.sack_fumbles + ts.rushing_fumbles as off_fumble
  , ts.sack_fumbles_lost + ts.rushing_fumbles_lost as fumble_lost
  , ts.passing_epa as pass_epa
  , ts.passing_cpoe as pass_cpoe
  , ts.passing_2pt_conversions + ts.rushing_2pt_conversions + ts.receiving_2pt_conversions as two_pt_conv
  , ts.carries as rush_att
  , ts.rushing_yards as rush_yd
  , ts.rushing_tds as rush_td
  , ts.rushing_epa as rush_epa
  , ts.receiving_air_yards as rec_air_yd
  , ts.receiving_yards_after_catch as rec_yac
  , ts.receiving_epa as rec_epa
  , ts.def_qb_hits as qb_hit
  , ts.def_sacks as sack
  , ts.def_interceptions as int
  , ts.def_fumbles_forced as def_fumble
  , ts.fumble_recovery_opp as fumble_rcvr
  , ts.def_tds + ts.fumble_recovery_tds as def_td
  , ts.def_safeties as safety
  , ts.def_punt_blocks + ts.def_pat_blocks + ts.fg_blocked as blk_kick
  , ts.special_teams_tds + ts.pt_return_tds as st_td
  , s.away_score as pts_allowed
  from read_parquet('${bucket}/silver/schedules/schedules.parquet', union_by_name = true) s
  left outer join read_parquet('${bucket}/silver/team_stats/team_stats.parquet', union_by_name = true) ts
    on s.season = ts.season
    and s.week = ts.week
    and s.home_team = ts.team
  
    UNION ALL
    
    select
    s.season || '-' || RIGHT('0' || s.week,2) as week_id
  , s.season || '-' || RIGHT('0' || s.week,2) || '-' || s.away_team || '-' || s.home_team as game_id
  , 'Away' as team_category
  , s.away_team as team
  , s.away_score as score
  , ts.completions as comp
  , ts.attempts as att
  , cast((ts.completions / ts.attempts) * 100 as decimal(10,2)) as comp_pct
  , ts.passing_yards as pass_yd
  , ts.passing_tds as pass_td
  , ts.passing_interceptions as int_thrown
  , ts.sack_fumbles + ts.rushing_fumbles as off_fumble
  , ts.sack_fumbles_lost + ts.rushing_fumbles_lost as fumble_lost
  , ts.passing_epa as pass_epa
  , ts.passing_cpoe as pass_cpoe
  , ts.passing_2pt_conversions + ts.rushing_2pt_conversions + ts.receiving_2pt_conversions as two_pt_conv
  , ts.carries as rush_att
  , ts.rushing_yards as rush_yd
  , ts.rushing_tds as rush_td
  , ts.rushing_epa as rush_epa
  , ts.receiving_air_yards as rec_air_yd
  , ts.receiving_yards_after_catch as rec_yac
  , ts.receiving_epa as rec_epa
  , ts.def_qb_hits as qb_hit
  , ts.def_sacks as sack
  , ts.def_interceptions as int
  , ts.def_fumbles_forced as def_fumble
  , ts.fumble_recovery_opp as fumble_rcvr
  , ts.def_tds + ts.fumble_recovery_tds as def_td
  , ts.def_safeties as safety
  , ts.def_punt_blocks + ts.def_pat_blocks + ts.fg_blocked as blk_kick
  , ts.special_teams_tds + ts.pt_return_tds as st_td
  , s.home_score as pts_allowed
  from read_parquet('${bucket}/silver/schedules/schedules.parquet', union_by_name = true) s
  left outer join read_parquet('${bucket}/silver/team_stats/team_stats.parquet', union_by_name = true) ts
    on s.season = ts.season
    and s.week = ts.week
    and s.away_team = ts.team
),

scoring_config as (
  select unnest(categories, recursive := true)
  from read_json('${bucket}/config/scoring.json')
),

pts_allowed_tiers as (
  -- "pts_allowed_-999_0" splits on "_" into ["pts","allowed","-999","0"] -
  -- split_part is 1-indexed, so parts 3 and 4 are min/max. Works fine with
  -- the negative sign since it's just part of the numeric token, not a
  -- delimiter itself.
  select
    cast(split_part(category, '_', 3) as integer) as min_val
  , cast(split_part(category, '_', 4) as integer) as max_val
  , points
  from scoring_config
  where category like 'pts\_allowed\_%' escape '\'
),

pts_allowed_scored as (
  select
    r.week_id
  , r.game_id
  , r.team_category
  , r.team
  , t.points as pts_allowed_points
  from raw_stats r
  left outer join pts_allowed_tiers t
    on r.pts_allowed between t.min_val and t.max_val
),

unpivoted as (
  unpivot raw_stats
  on sack, int, fumble_rcvr, def_td, safety, blk_kick, st_td
  into name category value stat_count
),

categorized as (
  select
    u.*
  , case when u.category in ('blk_kick', 'st_td') then 'special_teams' else 'defense' end as unit
  from unpivoted u
),

scored as (
  select
    c.week_id
  , c.game_id
  , c.team_category
  , c.team
  , sum(c.stat_count * sc.points) filter (where c.unit = 'defense')       as def_fpts
  , sum(c.stat_count * sc.points) filter (where c.unit = 'special_teams') as st_fpts
  from categorized c
  join scoring_config sc
    on c.category = sc.category
  group by c.week_id, c.game_id, c.team_category, c.team
)

select
  r.*
, s.def_fpts
, s.st_fpts
, coalesce(pa.pts_allowed_points, 0) as pts_allowed_fpts
, s.def_fpts + s.st_fpts + pts_allowed_fpts as dst_fpts
from raw_stats r
join scored s
  on r.week_id = s.week_id and r.game_id = s.game_id and r.team = s.team
left outer join pts_allowed_scored pa
  on r.week_id = pa.week_id and r.game_id = pa.game_id and r.team = pa.team