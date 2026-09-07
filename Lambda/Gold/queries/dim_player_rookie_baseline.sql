select
  dp.season
, case
	  when dp.round in (5,6,7) then 'Day 3'
	  else 'Round ' || dp.round
	end as draft_position
, case
	  when dp.round in (5,6,7) then 5
	  else dp.round
  end as min_round
, case
	  when dp.round in (5,6,7) then 7
	  else dp.round
  end as max_round
, dp.position
, fpss.game_category
, sum(fpss.games_played) as games_played
, sum(fpss.fpts) as fpts
, try_cast(sum(fpss.fpts) / sum(fpss.games_played) as decimal(10,2)) as fpts_pg
FROM read_parquet('${bucket}/silver/draft_picks/draft_picks.parquet', union_by_name = true) dp
join read_parquet('${bucket}/gold/facts/fact_player_stats_season.parquet', union_by_name = true) fpss
on dp.gsis_id = fpss.gsis_id
  and dp.season = fpss.season
where dp.round in (1,2,3,4,5,6,7)
group by 1,2,3,4,5,6