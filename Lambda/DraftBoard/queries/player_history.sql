select
  fdph.entity_id
, fdph.pos
, fdph.season
, fdph.fpts_pg
, fdph.availability
from read_parquet('${bucket}/gold/facts/fact_draft_player_history.parquet', union_by_name = true) fdph