with max_season as (
  select max(season) as max_season 
  from read_parquet('${bucket}/gold/dimensions/dim_calendar.parquet')
)

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
, dt.team_color2
, bool_or(1=1) as is_active
, bool_or(1=2) as is_rookie
, adp.ADP as adp_rank
from read_parquet('${bucket}/gold/facts/fact_draft_scores.parquet', union_by_name = true) fds
left outer join read_parquet('${bucket}/gold/dimensions/dim_team.parquet', union_by_name = true) dt
  on fds.entity_id = dt.team
left outer join read_parquet('${bucket}/gold/facts/fact_adp.parquet', union_by_name = true) adp
  on fds.entity_id = adp.entity_id
where fds.pos = 'DST'
group by
  fds.entity_id
, fds.pos
, dt.team
, dt.team_name
, fds.proj_fpts_pg
, fds.r_fpts_pg
, fds.draft_score
, dt.team_logo_squared
, dt.team_color
, dt.team_color2
, adp.ADP
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
, dt.team_color2
, dp.on_active_roster as is_active
, bool_or(dp.rookie_year = ms.max_season) as is_rookie
, adp.ADP as adp_rank
from read_parquet('${bucket}/gold/facts/fact_draft_scores.parquet', union_by_name = true) fds
left outer join read_parquet('${bucket}/gold/dimensions/dim_player.parquet', union_by_name = true) dp
  on fds.entity_id = dp.gsis_id
    and dp.end_week_id = '9999-99'
 left outer join read_parquet('${bucket}/gold/dimensions/dim_team.parquet', union_by_name = true) dt
  on dp.team = dt.team
 left outer join read_parquet('${bucket}/gold/facts/fact_adp.parquet', union_by_name = true) adp
  on fds.entity_id = adp.entity_id
 cross join max_season ms
where fds.pos <> 'DST'
group by
  fds.entity_id
, fds.pos
, dt.team
, dp.full_name
, fds.proj_fpts_pg
, fds.r_fpts_pg
, fds.draft_score
, dp.headshot_url
, dt.team_color
, dt.team_color2
, dp.on_active_roster
, adp.ADP