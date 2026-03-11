-- Add additional NBA prediction sources (batch 7)
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES
  ('numberfire', 'NumberFire', 'https://www.numberfire.com', 'http', true),
  ('basketball-reference', 'Basketball Reference', 'https://www.basketball-reference.com', 'http', true),
  ('swish-analytics', 'Swish Analytics', 'https://www.swishanalytics.com', 'browser', true),
  ('lineups-nba', 'Lineups NBA', 'https://www.lineups.com', 'http', true),
  ('nba-analysis', 'NBA Analysis', 'https://www.nbaanalysis.net', 'http', true),
  ('clutchpoints', 'ClutchPoints', 'https://www.clutchpoints.com', 'http', true),
  ('sportsline-nba', 'SportsLine NBA', 'https://www.sportsline.com', 'browser', true),
  ('mightytips-nba', 'MightyTips NBA', 'https://www.mightytips.com', 'http', true),
  ('hoopshype', 'HoopsHype', 'https://www.hoopshype.com', 'http', true),
  ('nba-betting', 'NBA Betting', 'https://www.nba-betting.net', 'http', true),
  ('basketball-insiders', 'Basketball Insiders', 'https://www.basketballinsiders.com', 'http', true),
  ('picks-hub', 'Picks Hub', 'https://pickshub.net', 'http', true),
  ('wagergnome', 'WagerGnome', 'https://www.wagergnome.com', 'http', true),
  ('betql-nba', 'BetQL NBA', 'https://www.betql.co', 'browser', true),
  ('hotstreak-nba', 'HotStreak NBA', 'https://www.hotstreak.gg', 'browser', true)
ON CONFLICT (slug) DO NOTHING;
