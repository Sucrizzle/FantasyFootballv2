select
  dp.season
, dp.gsis_id
, dp.round
, dp.pick
, cm_t.target
, dp.pfr_player_id
, dp.cfb_player_id
, dp.pfr_player_name
, dp.hof
, dp.position
, dp.category
, dp.side
, dp.college
, dp.age
, dp.to
, dp.allpro
, dp.probowls
, dp.seasons_started
, dp.w_av as weighted_approx_value
, dp.car_av as career_approx_value
, dp.dr_av as draft_approx_value
, dp.games
, dp.pass_completions
, dp.pass_attempts
, dp.pass_yards
, dp.pass_tds
, dp.pass_ints
, dp.rush_atts
, dp.rush_yards
, dp.rush_tds
, dp.receptions
, dp.rec_yards
, dp.rec_tds
, dp.def_solo_tackles
, dp.def_ints
, dp.def_sacks
from read_parquet('s3://fantasy-football-dev-808943963151-ca-central-1-an/bronze/draft_picks/season=*/draft_picks.parquet', union_by_name = true) dp
left outer join read_csv('s3://fantasy-football-dev-808943963151-ca-central-1-an/mappings/club_mapping.csv') cm_t
  on dp.team = cm_t.source