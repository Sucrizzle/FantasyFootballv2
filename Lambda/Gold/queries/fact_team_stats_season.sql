select
  dc.season
, ftsw.team
, ds.game_category
, count(ftsw.game_id) as games_played
, sum(ftsw.score) as total_points
, try_cast(total_points / games_played as decimal(10,2)) as points_per_game
, sum(case when ftsw.team_category = 'Home' then ftsw.score end) as points_home
, try_cast(points_home / sum(case when ftsw.team_category = 'Home' and not ds.is_neutral_location then 1 else 0 end) as decimal(10,2)) as points_home_per_game
, sum(case when ftsw.team_category = 'Away' then ftsw.score end) as points_away
, try_cast(points_away / sum(case when ftsw.team_category = 'Away' and not ds.is_neutral_location then 1 else 0 end) as decimal(10,2)) as points_away_per_game
, sum(case when ds.is_neutral_location = 'Y' then ftsw.score end) as points_neutral
, try_cast(points_neutral / sum(case when ds.is_neutral_location then 1 else 0 end) as decimal(10,2)) as points_neutral_per_game
FROM read_parquet('${bucket}/gold/facts/fact_team_stats_weekly.parquet', union_by_name = true) ftsw
join read_parquet('${bucket}/gold/dimensions/dim_schedule.parquet', union_by_name = true) ds
  on ftsw.game_id = ds.game_id
join read_parquet('${bucket}/gold/dimensions/dim_calendar.parquet', union_by_name = true) dc
  on ds.week_id = dc.week_id
group by 1,2,3