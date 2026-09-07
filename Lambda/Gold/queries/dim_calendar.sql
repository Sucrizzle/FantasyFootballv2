select
  s.season || '-' || RIGHT('0' || s.week,2) as week_id
, s.season
, s.week
, s.game_type
, min(gameday) as first_of_week
, max(gameday) as last_of_week
FROM read_parquet('${bucket}/silver/schedules/schedules.parquet', union_by_name = true) s
group by 
  s.season
, s.week
, s.game_type