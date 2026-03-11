-- Add new prediction sources (batch 9: soccer, tennis, NBA, MLB expansion)
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES
  -- Soccer
  ('betexplorer', 'BetExplorer', 'https://www.betexplorer.com', 'http', true),
  ('oddsportal', 'OddsPortal', 'https://www.oddsportal.com', 'browser', true),
  ('totalcorner', 'TotalCorner', 'https://www.totalcorner.com', 'http', true),
  ('soccerpunter', 'SoccerPunter', 'https://www.soccerpunter.com', 'http', true),
  ('soccerstats', 'SoccerStats', 'https://www.soccerstats.com', 'http', true),
  ('bettingexpert', 'BettingExpert', 'https://www.bettingexpert.com', 'http', true),
  ('flashscore-soccer', 'FlashScore Soccer', 'https://www.flashscore.com', 'browser', true),
  -- Tennis
  ('tennisabstract', 'Tennis Abstract', 'https://www.tennisabstract.com', 'http', true),
  ('oddschecker-tennis', 'OddsChecker Tennis', 'https://www.oddschecker.com', 'browser', true),
  -- NBA
  ('hashtagbasketball', 'Hashtag Basketball', 'https://hashtagbasketball.com', 'http', true),
  ('dunksandthrees', 'Dunks And Threes', 'https://dunksandthrees.com', 'http', true),
  ('pivotanalysis', 'Pivot Analysis', 'https://www.pivotanalysis.com', 'http', true),
  ('rotowire-nba', 'RotoWire NBA', 'https://www.rotowire.com', 'http', true),
  ('fantasylabs', 'FantasyLabs', 'https://www.fantasylabs.com', 'browser', true),
  ('sofascore-nba', 'SofaScore NBA', 'https://www.sofascore.com', 'browser', true),
  ('flashscore-nba', 'FlashScore NBA', 'https://www.flashscore.com', 'browser', true),
  ('oddschecker-nba', 'OddsChecker NBA', 'https://www.oddschecker.com', 'browser', true),
  -- MLB
  ('closingline', 'Closing Line', 'https://www.closingline.com', 'http', true),
  ('dailyfaceoff-mlb', 'Daily Faceoff MLB', 'https://www.dailyfaceoff.com', 'http', true),
  ('flashscore-mlb', 'FlashScore MLB', 'https://www.flashscore.com', 'browser', true),
  ('oddschecker-mlb', 'OddsChecker MLB', 'https://www.oddschecker.com', 'browser', true)
ON CONFLICT (slug) DO NOTHING;
