select
  s.season || '-' || RIGHT('0' || s.week,2) as week_id
, s.season || '-' || RIGHT('0' || s.week,2) || '-' || s.away_team || '-' || s.home_team as game_id
, s.game_type
, case 
    when s.game_type = 'REG' then 'Regular Season'
    when s.game_type in ('WC', 'DIV', 'CON', 'SB') then 'Playoff'
    else 'Unknown'
  end as game_category
, s.game_datetime
, bool_or( s.location= 'Neutral') as is_neutral_location
, s.away_team
, s.home_team
FROM read_parquet('BUCKET_PLACEHOLDER/silver/schedules/schedules.parquet', union_by_name = true) s
group by all