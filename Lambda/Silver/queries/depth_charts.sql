select
  dc.season
, dc.gsis_id
, COALESCE(cm_t.target, cm_cc.target) as team
, dc.last_name
, dc.first_name
, dc.football_name
, COALESCE(dc.full_name, dc.player_name) as full_name
, dc.jersey_number
, dc.week
, dc.game_type
, COALESCE(dc.dt, s.game_datetime) as dc_datetime_utc
, COALESCE(dc.pos_rank, CAST(dc.depth_team as INT)) as pos_rank
, dc.jersey_number
, COALESCE(dc.formation, fm.target) as formation
, dc.pos_grp_id
, dc.pos_grp
, dc.position
, dc.depth_position
, dc.pos_id
, dc.pos_name
, dc.pos_abb
, dc.pos_slot
, dc.elias_id
, dc.espn_id
from read_parquet('BUCKET_PLACEHOLDER/bronze/depth_charts/season=*/depth_charts.parquet', union_by_name = true) dc
	left outer join read_csv('BUCKET_PLACEHOLDER/mappings/club_mapping.csv') cm_cc
	  on dc.club_code = cm_cc.source
	left outer join read_csv('BUCKET_PLACEHOLDER/mappings/club_mapping.csv') cm_t
	  on dc.team = cm_t.source
	left outer join read_parquet('BUCKET_PLACEHOLDER/silver/schedules/schedules.parquet') s
	  on dc.season = s.season
	  and dc.week = s.week
	  and (COALESCE(cm_t.target, cm_cc.target) = s.away_team or COALESCE(cm_t.target, cm_cc.target) = s.home_team)
	left outer join read_csv('BUCKET_PLACEHOLDER/mappings/formation_mapping.csv') fm
	  on dc.pos_grp = fm.source
  
