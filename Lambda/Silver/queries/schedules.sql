select
  s.game_id
, s.season
, s.game_type
, s.week
, s.gameday
, s.weekday
, s.gametime
, strftime(
    timezone('UTC', timezone('America/New_York', CAST(gameday AS DATE) + CAST(gametime AS TIME))),
	'%Y-%m-%dT%H:%M:%SZ'
  ) AS game_datetime
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
from read_parquet('s3://fantasy-football-dev-808943963151-ca-central-1-an/bronze/schedules/season=*/schedules.parquet', union_by_name = true) s
left outer join read_csv('s3://fantasy-football-dev-808943963151-ca-central-1-an/mappings/club_mapping.csv') cm_at
  on s.away_team = cm_at.source
left outer join read_csv('s3://fantasy-football-dev-808943963151-ca-central-1-an/mappings/club_mapping.csv') cm_ht
  on s.home_team = cm_ht.source