select
  s.game_id
, s.season
, s.game_type
, s.week
, s.gameday
, s.weekday
, s.gametime
, cm_at.target as away_team
, s.away_score
, cm_ht.target as home_team
, s.home_score
, s.location
, s.result
, s.total
, s.overtime
, s.old_game_id
, s.gsis
, s.nfl_detail_id
, s.pfr
, s.pff
, s.espn
, s.ftn
, s.away_rest
, s.home_rest
, s.div_game
, s.roof
, s.surface
, s.temp
, s.wind
, s.stadium
from read_parquet('BUCKET_PLACEHOLDER/bronze/schedules/season=*/schedules.parquet', union_by_name = true) s
left outer join read_csv('BUCKET_PLACEHOLDER/mappings/club_mapping.csv') cm_at
  on s.away_team = cm_at.source
left outer join read_csv('BUCKET_PLACEHOLDER/mappings/club_mapping.csv') cm_ht
  on s.home_team = cm_ht.source
