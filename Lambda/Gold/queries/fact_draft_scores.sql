with roster_positions as (
  select unnest(slots, recursive := true)
  from read_json('${bucket}/config/roster_positions.json')
),

league_size as (
  select len(teams) as team_count
  from read_json('${bucket}/config/teams.json')
),

dst_season as (
  select season, team, fpts_pg
  from read_parquet('${bucket}/gold/facts/fact_team_stats_season.parquet', union_by_name = true)
  where game_category = 'Regular Season'
),

dst_most_recent_completed as (
  -- Exclude the current season if it's still in progress - a partial
  -- season shouldn't anchor "seasons ago" math or get treated as a full
  -- data point yet.
  select max(season) as season 
  from dst_season where season < (select max(season) from '${bucket}/gold/dimensions/dim_calendar.parquet')
),

dst_weighted as (
  select
    d.team
  , d.season
  , d.fpts_pg
  , power(0.60, (m.season - d.season)) as weight
  from dst_season d
  cross join dst_most_recent_completed m
  where d.season <= m.season
),

dst_proj_fpts_pg as (
	select
	  team
	, try_cast(sum(fpts_pg * weight) / sum(weight) as decimal(10,2)) as proj_fpts_pg
	from dst_weighted
	group by team
),

dst_slot_count as (
  select sum(count) as slots_per_team
  from roster_positions
  where list_contains(eligible_positions, 'DST')
    and slot_name != 'BENCH'
),

dst_replacement_rank as (
  select d.slots_per_team * l.team_count as rank_position
  from dst_slot_count d
  cross join league_size l
),

dst_ranked as (
  select
    team
  , proj_fpts_pg
  , row_number() over (order by proj_fpts_pg desc) as rnk
  from dst_proj_fpts_pg
),

dst_replacement_level as (
  select dst_ranked.proj_fpts_pg as r_fpts_pg
  from dst_ranked, dst_replacement_rank
  where dst_ranked.rnk = dst_replacement_rank.rank_position
),

off_season as (
  select ss.season, ss.gsis_id, dp.position, ss.fpts_pg, ss.games_played
  from read_parquet('${bucket}/gold/facts/fact_player_stats_season.parquet', union_by_name = true) ss
  join read_parquet('${bucket}/gold/dimensions/dim_player.parquet', union_by_name = true) dp
    on ss.gsis_id = dp.gsis_id
  where game_category = 'Regular Season'
    and dp.end_week_id = '9999-99'
),

off_most_recent_completed as (
  -- Exclude the current season if it's still in progress - a partial
  -- season shouldn't anchor "seasons ago" math or get treated as a full
  -- data point yet.
  select max(season) as season 
  from off_season where season < (select max(season) from '${bucket}/gold/dimensions/dim_calendar.parquet')
),

off_weighted as (
    SELECT
      os.gsis_id
    , os.season
    , os.position
    , os.fpts_pg
    , os.games_played
    , power(0.60, (m.season - os.season)) as decay
    FROM off_season os
    CROSS JOIN off_most_recent_completed m
    WHERE os.season <= m.season
),

-- total_weight is expressed in decayed GAMES, not decayed seasons - a
-- season-only weight caps at ~2.5 (the 0.6-decay geometric series' ceiling)
-- regardless of career length, which is meaningless next to a k_value
-- meant as "total number of games" of baseline confidence (see chat: the
-- original bug here was exactly this unit mismatch, not k_value's actual
-- number). Weighting by games_played per season also means a partial/
-- injury-shortened season contributes less than a full one, which
-- season-only decay couldn't express at all. A multi-season veteran's
-- total_weight now realistically lands in the 30-40+ range (several
-- seasons' worth of games, discounted for recency), comfortably dwarfing
-- a k_value around 17-20 (one season's worth) the way it should.
off_own_weighted_agg as (
    select
      gsis_id
    , position
    , sum(fpts_pg * games_played * decay) as weighted_sum
    , sum(games_played * decay) as total_weight
    from off_weighted
    group by gsis_id, position
),

-- NEW: tenure bucket per player, relative to the most recent completed season
off_player_tenure as (
    select
      dp.gsis_id
    , dp.position
    , dp.draft_round
    , case
        when m.season - dp.rookie_year < 1 then 'rookie'
        when m.season - dp.rookie_year = 1 then 'year_2'
        else 'year_3_plus'
      end as season_number
    from read_parquet('${bucket}/gold/dimensions/dim_player.parquet', union_by_name = true) dp
    cross join off_most_recent_completed m
    where dp.end_week_id = '9999-99'
),

-- NEW: baseline lookup per player, via round + position + tenure bucket
off_baseline as (
    select
      t.gsis_id
    , b.fpts_pg
    from off_player_tenure t
    join read_parquet('${bucket}/gold/dimensions/dim_player_rookie_baseline.parquet', union_by_name = true) b
      on (b.min_round <= t.draft_round and b.max_round >= t.draft_round)
     and b.position = t.position
    where b.game_category = 'Regular Season'
),

-- NEW: K per position, config-driven, not hardcoded
off_k_config as (
  select
	unnest(values, recursive := true)
	from read_json('${bucket}/config/k_values.json')
),

-- Gated by tenure, per the original design (docs/draft-score-calculation-
-- map-spec.md) - shrinkage toward a rookie/limited-history baseline
-- doesn't belong pulling down an established veteran's number, and it was
-- doing exactly that: total_weight tops out around 2.5 (the 0.6-decay
-- geometric series' ceiling) while k_value (17-20) dwarfed it, so the
-- baseline was overwhelming every player's own real production, not just
-- rookies. year_3_plus veterans now use their own weighted average outright
-- - only rookie/year_2 (genuinely limited history) go through the blend.
-- The nullif/coalesce fallback covers the rare veteran with zero weighted
-- history at all (e.g. returning from a full season out of the league) -
-- falls back to baseline rather than leaving proj_fpts_pg NULL.
off_proj_fpts_pg as (
    select
      dp.gsis_id
    , dp.position
    , try_cast(
        case
          when t.season_number = 'year_3_plus'
            then coalesce(w.weighted_sum / nullif(w.total_weight, 0), bl.fpts_pg)
          else (coalesce(w.weighted_sum, 0) + k.k_value * coalesce(bl.fpts_pg, 0))
               / (coalesce(w.total_weight, 0) + k.k_value)
        end
      as decimal(10,2)) as proj_fpts_pg
    from read_parquet('${bucket}/gold/dimensions/dim_player.parquet', union_by_name = true) dp
    join off_player_tenure t
      on t.gsis_id = dp.gsis_id and t.position = dp.position
    left join off_own_weighted_agg w
      on w.gsis_id = dp.gsis_id and w.position = dp.position
    left join off_baseline bl
      on bl.gsis_id = dp.gsis_id
    join off_k_config k
      on k.position = dp.position
    where dp.end_week_id = '9999-99'
),

off_slot_count as (
  select 
    slot_name
  , sum(count) as slots_per_team
  from roster_positions
  where list_has_any(eligible_positions, ['QB', 'WR', 'RB', 'TE'])
    and slot_name != 'BENCH'
  group by 1
),

off_replacement_rank as (
  select o.slot_name, o.slots_per_team * l.team_count as rank_position
  from off_slot_count o
  cross join league_size l
),

off_ranked as (
  select
    gsis_id
  , position
  , proj_fpts_pg
  , row_number() over (partition by position order by proj_fpts_pg desc) as rnk
  from off_proj_fpts_pg
),

off_replacement_level as (
  select off_ranked.position, off_ranked.proj_fpts_pg as r_fpts_pg
  from off_ranked
  join off_replacement_rank
    on off_ranked.position = off_replacement_rank.slot_name
   and off_ranked.rnk = off_replacement_rank.rank_position
)

select
  r.team as entity_id
, 'DST' as pos
, r.proj_fpts_pg
, rl.r_fpts_pg
, try_cast(r.proj_fpts_pg - rl.r_fpts_pg as decimal(10,2)) as draft_score
from dst_ranked r
cross join dst_replacement_level rl
union all
select
  r.gsis_id as entity_id
, r.position as pos
, r.proj_fpts_pg
, rl.r_fpts_pg
, try_cast(r.proj_fpts_pg - rl.r_fpts_pg as decimal(10,2)) as draft_score
from off_ranked r
join off_replacement_level rl
  on r.position = rl.position