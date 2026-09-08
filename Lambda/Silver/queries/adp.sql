-- Name formatting differs between the ADP source and rosters (e.g. ADP's
-- "Michael Pittman Jr." vs rosters' "Michael Pittman", "Tre' Harris" vs
-- "Tre Harris", or the reverse - "Harold Fannin" vs rosters' "Harold
-- Fannin Jr."). A raw name-string join silently drops every one of these,
-- and there are dozens just in one rookie class - not something worth
-- hardcoding exceptions for one at a time. Instead, both sides are reduced
-- to the same normalized key (lowercased, periods/apostrophes stripped,
-- trailing Jr/Sr/II/III/IV/V dropped) before joining, so e.g. "Michael
-- Pittman Jr." and "Michael Pittman" collapse to the same "michael
-- pittman" key regardless of which side bothered with the suffix.
--
-- What this can't fix: genuine nicknames (ADP's "Chigoziem Okonkwo" vs
-- rosters' "Chig Okonkwo", "Kenneth Gainwell" vs "Kenny Gainwell") aren't a
-- formatting difference - no normalization closes that gap, so whatever's
-- still unmatched after this runs is expected to be a short list worth
-- checking by hand, not a sign the regex needs to get cleverer.
with name_keyed_rosters as (
    select gsis_id, full_name, name_key
    from (
        select
          gsis_id
        , full_name
        , season
        , lower(trim(regexp_replace(
            regexp_replace(full_name, '[.'']', '', 'g'),
            '\s+(jr|sr|ii|iii|iv|v)$', '', 'i'
          ))) as name_key
        from read_parquet('${bucket}/silver/rosters/rosters.parquet', union_by_name = true)
    )
    -- Each name's single most recent season, not just the current one -
    -- someone an ADP list still ranks (a recently-released veteran like
    -- Tyreek Hill or Kareem Hunt, speculatively drafted in case they sign
    -- somewhere) may not be on any team's roster as of this year's
    -- snapshot at all. Falling back to their last known season still
    -- resolves a real gsis_id instead of leaving them unmatched. This
    -- widens the earlier "only the current season" collision risk
    -- slightly (two different people across different years sharing a
    -- normalized name), but that's the same "short list to check by hand"
    -- tradeoff already accepted for nicknames above.
    qualify row_number() over (partition by name_key order by season desc) = 1
),

adp_keyed as (
    select
      ADP
    , season
    , Player
    , lower(trim(regexp_replace(
        regexp_replace(Player, '[.'']', '', 'g'),
        '\s+(jr|sr|ii|iii|iv|v)$', '', 'i'
      ))) as name_key
    from read_csv('${bucket}/bronze/adp/season=2026/4for4-superflex-adp-table.csv')
)


select distinct
  adp.season
, adp.ADP
, COALESCE(r.gsis_id, cm.target) as entity_id
, Player
from adp_keyed adp
left outer join name_keyed_rosters r
  on adp.name_key = r.name_key
left outer join read_parquet('${bucket}/silver/teams/teams.parquet', union_by_name = true) t
  on adp.Player = t.team_name
left outer join read_csv('${bucket}/mappings/club_mapping.csv') cm
  on t.team = cm.source