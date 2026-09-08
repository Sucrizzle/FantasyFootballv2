select
  fds.entity_id
, fds.pos
, tss.season
, tss.fpts_pg
, 1.00 as availability
from read_parquet('${bucket}/gold/facts/fact_draft_scores.parquet', union_by_name = true) fds
left outer join read_parquet('${bucket}/gold/facts/fact_team_stats_season.parquet', union_by_name = true) tss
  on fds.entity_id = tss.team
 where tss.game_category = 'Regular Season' 
   and fds.pos = 'DST'
UNION ALL
select
  fds.entity_id
, fds.pos
, pss.season
, pss.fpts_pg
, pss.availability
from read_parquet('${bucket}/gold/facts/fact_draft_scores.parquet', union_by_name = true) fds
left outer join read_parquet('${bucket}/gold/facts/fact_player_stats_season.parquet', union_by_name = true) pss
  on fds.entity_id = pss.gsis_id
 where pss.game_category = 'Regular Season' 
   and fds.pos <> 'DST'