-- Get team history information
select
  fds.entity_id
, fds.pos
, tss.season
, tss.fpts_pg
from read_parquet('${bucket}/gold/facts/fact_draft_scores.parquet', union_by_name = true) fds
left outer join read_parquet('${bucket}/gold/facts/fact_team_stats_season.parquet', union_by_name = true) tss
  on fds.entity_id = tss.team
 where tss.game_category = 'Regular Season' 