-- Add tennis prediction sources
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES
  ('tennis-predict', 'Tennis Predict', 'https://tennispredict.com', 'http', true),
  ('tennis-explorer', 'Tennis Explorer', 'https://www.tennisexplorer.com', 'http', true),
  ('sofascore-tennis', 'Sofascore Tennis', 'https://www.sofascore.com', 'browser', true),
  ('flashscore-tennis', 'Flashscore Tennis', 'https://www.flashscore.com', 'browser', true),
  ('betting-expert-tennis', 'Betting Expert Tennis', 'https://www.bettingexpert.com', 'http', true),
  ('tennis-tips-uk', 'Tennis Tips UK', 'https://www.tennistips.co.uk', 'http', true),
  ('olbg-tennis', 'OLBG Tennis', 'https://www.olbg.com', 'http', true),
  ('betideas-tennis', 'BetIdeas Tennis', 'https://www.betideas.com', 'http', true),
  ('mybetting-tennis', 'MyBetting Tennis', 'https://www.mybetting.com', 'http', true),
  ('mightytips-tennis', 'MightyTips Tennis', 'https://www.mightytips.com', 'http', true),
  ('statsinsider-tennis', 'StatsInsider Tennis', 'https://www.statsinsider.com.au', 'browser', true),
  ('tennisstats247', 'TennisStats247', 'https://www.tennisstats247.com', 'http', true),
  ('prosportstips-tennis', 'ProSportsTips Tennis', 'https://www.prosportstips.com', 'http', true),
  ('betsapi-tennis', 'BetsAPI Tennis', 'https://betsapi.com', 'http', true)
ON CONFLICT (slug) DO NOTHING;
