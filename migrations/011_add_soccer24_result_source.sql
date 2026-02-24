-- Soccer24 as a result source for grading football predictions.
-- No schema change needed (result_source is a TEXT column),
-- but we add common soccer team aliases to improve match resolution.

-- Common team name aliases for major European football leagues.
-- These map Soccer24 team names to prediction adapter team names.
-- Teams auto-created by prediction adapters may use different name variants.

-- Helper function to add alias if team exists
CREATE OR REPLACE FUNCTION add_team_alias_if_exists(p_team_name TEXT, p_alias TEXT) RETURNS VOID AS $$
DECLARE
  v_team_id INTEGER;
BEGIN
  SELECT id INTO v_team_id FROM teams WHERE LOWER(name) = LOWER(p_team_name) LIMIT 1;
  IF v_team_id IS NOT NULL THEN
    INSERT INTO team_aliases (team_id, alias)
    VALUES (v_team_id, LOWER(p_alias))
    ON CONFLICT (alias, team_id) DO NOTHING;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Premier League common variants
SELECT add_team_alias_if_exists('Manchester United', 'manchester utd');
SELECT add_team_alias_if_exists('Manchester United', 'man utd');
SELECT add_team_alias_if_exists('Manchester United', 'man united');
SELECT add_team_alias_if_exists('Manchester City', 'man city');
SELECT add_team_alias_if_exists('Manchester City', 'manchester city');
SELECT add_team_alias_if_exists('Tottenham Hotspur', 'tottenham');
SELECT add_team_alias_if_exists('Tottenham Hotspur', 'spurs');
SELECT add_team_alias_if_exists('Newcastle United', 'newcastle utd');
SELECT add_team_alias_if_exists('Newcastle United', 'newcastle');
SELECT add_team_alias_if_exists('West Ham United', 'west ham utd');
SELECT add_team_alias_if_exists('West Ham United', 'west ham');
SELECT add_team_alias_if_exists('Wolverhampton Wanderers', 'wolverhampton');
SELECT add_team_alias_if_exists('Wolverhampton Wanderers', 'wolves');
SELECT add_team_alias_if_exists('Nottingham Forest', 'nott\'m forest');
SELECT add_team_alias_if_exists('Nottingham Forest', 'nottingham');
SELECT add_team_alias_if_exists('Leicester City', 'leicester');
SELECT add_team_alias_if_exists('Brighton & Hove Albion', 'brighton');
SELECT add_team_alias_if_exists('AFC Bournemouth', 'bournemouth');
SELECT add_team_alias_if_exists('Crystal Palace', 'crystal palace');

-- La Liga common variants
SELECT add_team_alias_if_exists('Atletico Madrid', 'atl. madrid');
SELECT add_team_alias_if_exists('Atletico Madrid', 'atletico');
SELECT add_team_alias_if_exists('Real Betis', 'betis');
SELECT add_team_alias_if_exists('Real Sociedad', 'r. sociedad');
SELECT add_team_alias_if_exists('Athletic Bilbao', 'ath bilbao');
SELECT add_team_alias_if_exists('Athletic Bilbao', 'athletic club');
SELECT add_team_alias_if_exists('Celta Vigo', 'celta');
SELECT add_team_alias_if_exists('Deportivo Alaves', 'alaves');

-- Bundesliga common variants
SELECT add_team_alias_if_exists('Bayern Munich', 'bayern');
SELECT add_team_alias_if_exists('Bayern Munich', 'bayern munchen');
SELECT add_team_alias_if_exists('Bayern Munich', 'fc bayern');
SELECT add_team_alias_if_exists('Borussia Dortmund', 'dortmund');
SELECT add_team_alias_if_exists('Borussia Dortmund', 'bor. dortmund');
SELECT add_team_alias_if_exists('RB Leipzig', 'rb leipzig');
SELECT add_team_alias_if_exists('Bayer Leverkusen', 'leverkusen');
SELECT add_team_alias_if_exists('Borussia Monchengladbach', 'b. monchengladbach');
SELECT add_team_alias_if_exists('Eintracht Frankfurt', 'ein. frankfurt');
SELECT add_team_alias_if_exists('VfB Stuttgart', 'stuttgart');

-- Serie A common variants
SELECT add_team_alias_if_exists('AC Milan', 'milan');
SELECT add_team_alias_if_exists('Inter Milan', 'inter');
SELECT add_team_alias_if_exists('Inter Milan', 'internazionale');
SELECT add_team_alias_if_exists('Juventus', 'juventus fc');
SELECT add_team_alias_if_exists('AS Roma', 'roma');
SELECT add_team_alias_if_exists('SSC Napoli', 'napoli');
SELECT add_team_alias_if_exists('SS Lazio', 'lazio');
SELECT add_team_alias_if_exists('ACF Fiorentina', 'fiorentina');
SELECT add_team_alias_if_exists('Atalanta BC', 'atalanta');

-- Ligue 1 common variants
SELECT add_team_alias_if_exists('Paris Saint-Germain', 'paris sg');
SELECT add_team_alias_if_exists('Paris Saint-Germain', 'psg');
SELECT add_team_alias_if_exists('Olympique Marseille', 'marseille');
SELECT add_team_alias_if_exists('Olympique Lyonnais', 'lyon');
SELECT add_team_alias_if_exists('AS Monaco', 'monaco');
SELECT add_team_alias_if_exists('LOSC Lille', 'lille');

-- Clean up helper function
DROP FUNCTION add_team_alias_if_exists(TEXT, TEXT);
