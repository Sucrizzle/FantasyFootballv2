-- Enrichment for display lives here, in the serving-layer query - not in
-- fact_draft_scores.sql itself. That fact table holds keys (entity_id),
-- not denormalized dimension attributes; joining in dim_team's team_name
-- belongs at read/serve time, same separation the rest of the gold layer
-- already follows (facts join to dims, dims aren't baked into facts).
--
-- entity_id is the team abbreviation for DST rows today - joins straight
-- to dim_team. Once QB/RB/WR/TE rows exist, entity_id becomes gsis_id for
-- those, and this query will need a per-position join (dim_player for the
-- name, plus wherever "current team" ends up living) rather than the
-- single dim_team join below.
select
  fds.entity_id
, fds.pos
, dt.team
, dt.team_name as player_name
, fds.proj_fpts_pg
, fds.r_fpts_pg
, fds.draft_score
, dt.team_logo_squared as image_url
, dt.team_color
from read_parquet('${bucket}/gold/facts/fact_draft_scores.parquet', union_by_name = true) fds
left outer join read_parquet('${bucket}/gold/dimensions/dim_team.parquet', union_by_name = true) dt
  on fds.entity_id = dt.team
where fds.pos = 'DST'
 union all 
select
  fds.entity_id
, fds.pos
, dt.team
, dp.full_name as player_name
, fds.proj_fpts_pg
, fds.r_fpts_pg
, fds.draft_score
, dp.headshot_url as image_url
, dt.team_color
from read_parquet('${bucket}/gold/facts/fact_draft_scores.parquet', union_by_name = true) fds
left outer join read_parquet('${bucket}/gold/dimensions/dim_player.parquet', union_by_name = true) dp
  on fds.entity_id = dp.gsis_id
    and dp.end_week_id = '9999-99'
 left outer join read_parquet('${bucket}/gold/dimensions/dim_team.parquet', union_by_name = true) dt
  on dp.team = dt.team
where fds.pos <> 'DST'
