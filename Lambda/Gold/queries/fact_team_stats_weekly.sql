select
  s.season || '-' || RIGHT('0' || s.week,2) as week_id
, s.season || '-' || RIGHT('0' || s.week,2) || '-' || s.away_team || '-' || s.home_team as game_id
, 'Home' as team_category
, s.home_team as team
, s.home_score as score
FROM read_parquet('BUCKET_PLACEHOLDER/silver/schedules/schedules.parquet', union_by_name = true) s
UNION 
select
  s.season || '-' || RIGHT('0' || s.week,2) as week_id
, s.season || '-' || RIGHT('0' || s.week,2) || '-' || s.away_team || '-' || s.home_team as game_id
, 'Away' as team_category
, s.away_team as team
, s.away_score as score
FROM read_parquet('BUCKET_PLACEHOLDER/silver/schedules/schedules.parquet', union_by_name = true) s