select
  i.season
, i.gsis_id
, i.game_type
, cm_t.target as team
, i.week
, i.position
, i.full_name
, i.first_name
, i.last_name
, i.report_primary_injury
, i.report_secondary_injury
, i.report_status
, i.practice_primary_injury
, i.practice_secondary_injury
, i.date_modified
, i.season_type
from read_parquet('s3://fantasy-football-dev-808943963151-ca-central-1-an/bronze/injuries/season=*/injuries.parquet', union_by_name = true) i
left outer join read_csv('s3://fantasy-football-dev-808943963151-ca-central-1-an/mappings/club_mapping.csv') cm_t
  on i.team = cm_t.source