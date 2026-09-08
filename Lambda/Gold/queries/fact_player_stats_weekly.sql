with raw_stats as
(
	select
	  s.season || '-' || RIGHT('0' || s.week,2) as week_id
	, s.season || '-' || RIGHT('0' || s.week,2) || '-' || s.away_team || '-' || s.home_team as game_id
	, ws.team
	, case 
	    when ws.team = s.home_team then 'Home'	
	    when ws.team = s.away_team then 'Away'
	    else 'Unknown'
	  end as team_category
	, ws.gsis_id
	, ws.completions as comp
	, ws.attempts as att
	, try_cast((ws.completions / NULLIF(ws.attempts, 0)) * 100 as decimal(10,2)) as comp_pct
	, ws.passing_yards as pass_yd
	, ws.passing_tds as pass_td
	, ws.passing_interceptions as int_thrown
	, ws.rushing_yards as rush_yd
	, ws.rushing_tds as rush_td
	, ws.receptions as rec
	, ws.receiving_yards as rec_yd
	, ws.receiving_tds as rec_td
	, ws.rushing_fumbles_lost + ws.receiving_fumbles_lost + sack_fumbles_lost as fumble_lost
	, ws.fumble_recovery_tds as off_fumble_ret_td
	, ws.passing_2pt_conversions + ws.rushing_2pt_conversions + ws.receiving_2pt_conversions as two_pt_conv
	, ws.fg_made_0_19
	, ws.fg_made_20_29
	, ws.fg_made_30_39
	, ws.fg_made_40_49
	, ws.fg_made_50_59
	, ws.fg_made_60_
	, ws.pat_made
	from read_parquet('${bucket}/silver/weekly_stats/weekly_stats.parquet', union_by_name = true) ws
	left outer join read_parquet('${bucket}/silver/schedules/schedules.parquet', union_by_name = true) s
	  on ws.season = s.season
	  and ws.week = s.week
	  and (ws.team = s.home_team or ws.team = s.away_team)
),

scoring_config as (
  select unnest(categories, recursive := true)
  from read_json('${bucket}/config/scoring.json')
),

unpivoted as (
  unpivot raw_stats
  on pass_yd, pass_td, int_thrown, rush_yd, rush_td, rec, rec_yd, rec_td, two_pt_conv, fumble_lost, off_fumble_ret_td,
     fg_made_0_19, fg_made_20_29, fg_made_30_39, fg_made_40_49, fg_made_50_59, fg_made_60_
  into name category value stat_count
),

categorized as (
  select
    u.*
  , case 
	    when u.category in ('pass_yd', 'pass_td', 'int_thrown') then 'passing'
	    when u.category in ('rush_yd', 'rush_td') then 'rushing'
	    when u.category in ('rec', 'rec_yd', 'rec_td') then 'receiving'
	    when u.category in ('two_pt_conv','fumble_lost','off_fumble_ret_td') then 'other'
	    when u.category in ('fg_made_0_19', 'fg_made_20_29', 'fg_made_30_39', 'fg_made_40_49', 'fg_made_50_59', 'fg_made_60_') then 'kicking'
      else 'unknown'
    end as unit
  from unpivoted u
),

scored as (
  select
    c.week_id
  , c.game_id
  , c.gsis_id
  , sum(c.stat_count * sc.points) filter (where c.unit = 'passing') as pass_fpts
  , sum(c.stat_count * sc.points) filter (where c.unit = 'rushing') as rush_fpts
  , sum(c.stat_count * sc.points) filter (where c.unit = 'receiving') as rec_fpts
  , sum(c.stat_count * sc.points) filter (where c.unit = 'other') as other_fpts
  , sum(c.stat_count * sc.points) filter (where c.unit = 'kicking') as kicking_fpts
  from categorized c
  join scoring_config sc
    on c.category = sc.category
  group by c.week_id, c.game_id, c.gsis_id
)


select
  r.*
, s.pass_fpts
, s.rush_fpts
, s.rec_fpts
, s.other_fpts
, s.kicking_fpts
, s.pass_fpts + s.rush_fpts + s.rec_fpts + s.other_fpts + s.kicking_fpts as off_fpts
from raw_stats r
join scored s
  on r.week_id = s.week_id and r.game_id = s.game_id and r.gsis_id = s.gsis_id
 
  
