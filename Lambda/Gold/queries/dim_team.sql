select
  t.team_id
, t.team
, t.team_name
, t.team_nick
, t.team_conf
, t.team_division
, t.team_division_abbr
, t.team_color
, t.team_color2
, t.team_color3
, t.team_color4
, t.team_logo_wikipedia
, t.team_logo_espn
, t.team_wordmark
, t.team_conference_logo
, t.team_league_logo
, t.team_logo_squared
FROM read_parquet('${bucket}/silver/teams/teams.parquet', union_by_name = true) t