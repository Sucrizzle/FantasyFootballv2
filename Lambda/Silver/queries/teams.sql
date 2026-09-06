select
  t.team_id
, t.team_abbr as t.team
, t.team_name
, t.team_nick
, t.team_conf
, t.team_division
, LEFT(t.team_division,3) || SUBSTR(t.team_division,5,1) as team_division_abbr
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
FROM read_parquet('BUCKET_PLACEHOLDER/bronze/teams/teams.parquet', union_by_name = true) t