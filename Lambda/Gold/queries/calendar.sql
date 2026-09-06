select distinct
  s.season
, s.week
, s.game_type
, min(gameday) as first_of_week
, max(gameday) as last_of_week
FROM read_parquet('s3://fantasy-football-dev-808943963151-ca-central-1-an/silver/schedules/schedules.parquet', union_by_name = true) s
group by 
  s.season
, s.week
, s.game_type