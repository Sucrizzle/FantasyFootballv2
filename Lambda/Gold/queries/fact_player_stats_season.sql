with gp as
(
	  select
    dc.season
  , ds.game_category
  , ds.home_team as team
  from read_parquet('${bucket}/gold/dimensions/dim_schedule.parquet', union_by_name = true) ds
  join read_parquet('${bucket}/gold/dimensions/dim_calendar.parquet', union_by_name = true) dc
    on ds.week_id = dc.week_id
  UNION ALL
  select
    dc.season
  , ds.game_category
  , ds.away_team as team
  from read_parquet('${bucket}/gold/dimensions/dim_schedule.parquet', union_by_name = true) ds
  join read_parquet('${bucket}/gold/dimensions/dim_calendar.parquet', union_by_name = true) dc
    on ds.week_id = dc.week_id
)

, gp_season as
(
  select
    season
  , team
  , game_category
  , count(*) as team_games_played
  from gp
  group by 1,2,3
)

select
  dc.season
, fpsw.gsis_id
, ds.game_category
, fpsw.team
, gp.team_games_played
, count(fpsw.game_id) as games_played
, try_cast(games_played / gp.team_games_played as decimal(10,2)) as availability
, sum(pass_fpts) as season_pass_fpts
, try_cast(season_pass_fpts / games_played as decimal(10,2)) as pass_fpts_pg
, sum(rush_fpts) as season_rush_fpts
, try_cast(season_rush_fpts / games_played as decimal(10,2)) as rush_fpts_pg
, sum(rec_fpts) as season_rec_fpts
, try_cast(season_rec_fpts / games_played as decimal(10,2)) as rec_fpts_pg
, sum(other_fpts) as season_other_fpts
, try_cast(season_other_fpts / games_played as decimal(10,2)) as other_fpts_pg
, sum(off_fpts) as fpts
, try_cast(fpts / games_played as decimal(10,2)) as fpts_pg
FROM read_parquet('${bucket}/gold/facts/fact_player_stats_weekly.parquet', union_by_name = true) fpsw
join read_parquet('${bucket}/gold/dimensions/dim_schedule.parquet', union_by_name = true) ds
  on fpsw.game_id = ds.game_id
join read_parquet('${bucket}/gold/dimensions/dim_calendar.parquet', union_by_name = true) dc
  on ds.week_id = dc.week_id
join gp_season gp
  on dc.season = gp.season
  and ds.game_category = gp.game_category
  and  fpsw.team = gp.team
group by 1,2,3,4,5