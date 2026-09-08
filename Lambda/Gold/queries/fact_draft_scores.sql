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

off_flex_shares as (
  -- Explicit schema, not auto-detected - a league with no FLEX/SUPERFLEX
  -- slot (like this one, today) saves this as {"shares": []}, and DuckDB
  -- can't infer a struct's field names from an empty array. Without this,
  -- fs.slot_name/fs.position below don't exist as columns at all whenever
  -- the list happens to be empty.
  select unnest(shares, recursive := true)
  from read_json(
    '${bucket}/config/flex_shares.json',
    columns = {shares: 'STRUCT(slot_name VARCHAR, position VARCHAR, share_pct DOUBLE)[]'}
  )
),

off_positions as (
  select unnest(['QB', 'RB', 'WR', 'TE', 'K']) as position
),

-- Effective slot count PER POSITION, not per slot_name - a dedicated slot
-- (exactly one eligible position, e.g. QB's own slot) contributes its full
-- count to that one position. A multi-position slot (FLEX, SUPERFLEX)
-- contributes count * that position's configured share instead - one FLEX
-- slot isn't "one whole slot" for RB, WR, AND TE simultaneously, it's one
-- slot apportioned by expected usage across the positions eligible for it.
-- This replaces slot_name entirely as the join key into off_replacement_
-- level below - slot_name was never a real position (SUPERFLEX/FLEX
-- silently matched nothing there), position always is.
off_position_slot_count as (
  select
    p.position
  , sum(
      case
        when len(rp.eligible_positions) = 1 then rp.count
        else rp.count * coalesce(fs.share_pct, 0)
      end
    ) as slots_per_team
  from roster_positions rp
  cross join off_positions p
  left outer join off_flex_shares fs
    on fs.slot_name = rp.slot_name and fs.position = p.position
  where list_contains(rp.eligible_positions, p.position)
    and rp.slot_name != 'BENCH'
  group by 1
),

off_replacement_rank as (
  -- Rounded to the nearest whole rank - fractional shares (e.g. a FLEX
  -- slot split 50/45/5 across RB/WR/TE) can leave slots_per_team * teams
  -- non-integer, but row_number() below only ever produces whole numbers,
  -- so this needs to land on one to actually match a real ranked player.
  select o.position, round(o.slots_per_team * l.team_count)::integer as rank_position
  from off_position_slot_count o
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
    on off_ranked.position = off_replacement_rank.position
   and off_ranked.rnk = off_replacement_rank.rank_position
),

-- Wrapped as a CTE (was the bare final select) so tier_cliff below can
-- build on top of it - everything from here down operates on the unified
-- DST+offense pool, not either branch separately.
draft_scores as (
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
),

-- dst_replacement_rank has no `position` column (it's implicitly DST-only,
-- one group) while off_replacement_rank has one per offensive position -
-- union them into one common (pos, rank_position) shape so tier_cliff
-- below can look up either kind the same way.
all_replacement_rank as (
  select 'DST' as pos, rank_position from dst_replacement_rank
  union all
  select position as pos, rank_position from off_replacement_rank
),

ranked_for_tiers as (
  select
    entity_id
  , pos
  , draft_score
  , row_number() over (partition by pos order by draft_score desc) as rnk
  from draft_scores
),

-- Only the meaningfully-relevant pool per position - top 2x replacement
-- rank (starters plus realistic bench/handcuff value). Hundreds of deep-
-- bench players at a position are all bunched within a point or two of
-- replacement level; including them would swamp the average gap with
-- near-zero values and make the threshold oversensitive right where it
-- matters (the top of the board), not just add a few outliers median
-- would smooth over - the skew is in HOW MANY irrelevant players there
-- are, not their magnitude.
eligible_for_tiers as (
  select rt.entity_id, rt.pos, rt.draft_score, rt.rnk
  from ranked_for_tiers rt
  join all_replacement_rank rr on rr.pos = rt.pos
  where rt.rnk <= 2 * rr.rank_position
),

-- Banded by distance from the position's own top score, in units of that
-- position's own draft_score spread - NOT gap-outlier detection (tried
-- first, dropped). Gap detection only flags a tier break where there's one
-- *surprising jump* between consecutive players, which misses real
-- cumulative separation on a position that declines gradually with no
-- single sharp break - confirmed on DST, where avg_gap + 1 stddev on the
-- GAPS produced 3 tiers (DEN alone, SEA alone, then everyone else lumped
-- into one tier spanning a full 2+ points, 1.07 down to -0.97, since no
-- individual gap in that stretch ever looked "surprising" even though the
-- total spread clearly wasn't one tier's worth of value). Banding by the
-- position's own stddev of draft_score instead asks "how far is this
-- player from the top, relative to how spread out this position actually
-- is" - it doesn't need a dramatic jump anywhere, so smooth, gradual
-- declines still get split into real, meaningfully-different bands. 0.75
-- stddev per tier was tuned by eye against real data across every
-- position (5-6 tiers each, sensible group sizes, no giant blobs) - see
-- chat if this ever needs retuning.
tier_config as (
  select 0.75 as band_width  -- smaller = more, narrower tiers; larger = fewer, wider tiers
),

tier_position_stats as (
  select pos, max(draft_score) as max_score, stddev_samp(draft_score) as stddev_score
  from eligible_for_tiers
  group by pos
),

tiered as (
  select
    e.entity_id
  , e.pos
  , e.draft_score
  , 1 + floor((ps.max_score - e.draft_score) / (tc.band_width * ps.stddev_score))::integer as tier
  from eligible_for_tiers e
  join tier_position_stats ps on ps.pos = e.pos
  cross join tier_config tc
),

tier_avg as (
  select pos, tier, avg(draft_score) as tier_avg_score
  from tiered
  group by pos, tier
),

tier_cliff as (
  select
    t.entity_id
  , t.pos
  , t.tier
  , t.draft_score - na.tier_avg_score as tier_cliff
  from tiered t
  left outer join tier_avg na
    on na.pos = t.pos and na.tier = t.tier + 1
)

select
  ds.entity_id
, ds.pos
, ds.proj_fpts_pg
, ds.r_fpts_pg
, ds.draft_score
-- NULL for anyone outside the eligible (top 2x replacement) window - they
-- were never tiered at all, so a fabricated tier number would be
-- misleading. Kept alongside tier_cliff (persisted, not just an
-- intermediate CTE value) specifically to make troubleshooting/consuming
-- this easier - "why is this player's cliff X" is answerable by eye once
-- you can see which tier they landed in.
, tc.tier
-- 0 for anyone outside the eligible (top 2x replacement) window, or last
-- in their position's final tier (no next tier down to fall off a cliff
-- into) - no real urgency signal for either case.
, coalesce(tc.tier_cliff, 0) as tier_cliff
from draft_scores ds
left outer join tier_cliff tc
  on tc.entity_id = ds.entity_id and tc.pos = ds.pos