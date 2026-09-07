select
  dc.season
, ftsw.team
, ds.game_category
, count(ftsw.game_id) as games_played
, sum(ftsw.score) as season__pts
, try_cast(season__pts / games_played as decimal(10,2)) as pts_per_game
, sum(case when ftsw.team_category = 'Home' then ftsw.score end) as pts_home
, try_cast(pts_home / sum(case when ftsw.team_category = 'Home' and not ds.is_neutral_location then 1 else 0 end) as decimal(10,2)) as pts_home_pg
, sum(case when ftsw.team_category = 'Away' then ftsw.score end) as pts_away
, try_cast(pts_away / sum(case when ftsw.team_category = 'Away' and not ds.is_neutral_location then 1 else 0 end) as decimal(10,2)) as pts_away_pg
, sum(case when ds.is_neutral_location = 'Y' then ftsw.score end) as pts_neutral
, try_cast(pts_neutral / sum(case when ds.is_neutral_location then 1 else 0 end) as decimal(10,2)) as pts_neutral_pg
, sum(def_fpts) as season_def_fpts
, try_cast(season_def_fpts / games_played as decimal(10,2)) as def_fpts_pg
, sum(st_fpts) as season_st_fpts
, try_cast(season_st_fpts / games_played as decimal(10,2)) as st_fpts_pg
, sum(pts_allowed_fpts) as season_pts_allowed_fpts
, try_cast(season_pts_allowed_fpts / games_played as decimal(10,2)) as pts_allowed_fpts_pg
, sum(dst_fpts) as season_dst_fpts
, try_cast(season_dst_fpts / games_played as decimal(10,2)) as dst_fpts_pg
FROM read_parquet('${bucket}/gold/facts/fact_team_stats_weekly.parquet', union_by_name = true) ftsw
join read_parquet('${bucket}/gold/dimensions/dim_schedule.parquet', union_by_name = true) ds
  on ftsw.game_id = ds.game_id
join read_parquet('${bucket}/gold/dimensions/dim_calendar.parquet', union_by_name = true) dc
  on ds.week_id = dc.week_id
group by 1,2,3