select
  r.season
, cm_t.target as team
, r.position
, r.depth_chart_position
, r.jersey_number
, r.status
, r.full_name
, r.football_name first_name
, r.last_name
, r.birth_date
, r.height
, r.weight
, r.college
, r.gsis_id
, r.yahoo_id
, r.pff_id
, r.years_exp
, r.headshot_url
, r.week
, r.game_type
, r.rookie_year
, COALESCE(cm_dc.target, 'UDFA') as draft_club
, r.draft_number
from read_parquet(
    'BUCKET_PLACEHOLDER/bronze/rosters/season=*/rosters.parquet',
    union_by_name = true
) r
left outer join read_csv('BUCKET_PLACEHOLDER/mappings/club_mapping.csv') cm_t
  on r.team = cm_t.source
left outer join read_csv('BUCKET_PLACEHOLDER/mappings/club_mapping.csv') cm_dc
  on r.draft_club = cm_dc.source
