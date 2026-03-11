-- Add additional MLB prediction sources (batch 8)
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES
  ('baseball-reference', 'Baseball Reference', 'https://www.baseball-reference.com', 'http', true),
  ('fangraphs', 'FanGraphs', 'https://www.fangraphs.com', 'http', true),
  ('mlb-picks-today', 'MLB Picks Today', 'https://www.mlbpickstoday.com', 'http', true),
  ('mightytips-mlb', 'MightyTips MLB', 'https://www.mightytips.com', 'http', true),
  ('numberfire-mlb', 'NumberFire MLB', 'https://www.numberfire.com', 'http', true),
  ('sportsline-mlb', 'SportsLine MLB', 'https://www.sportsline.com', 'browser', true),
  ('lineups-mlb', 'Lineups MLB', 'https://www.lineups.com', 'http', true),
  ('betql-mlb', 'BetQL MLB', 'https://www.betql.co', 'browser', true),
  ('baseball-savant', 'Baseball Savant', 'https://baseballsavant.mlb.com', 'http', true),
  ('rotowire-mlb', 'RotoWire MLB', 'https://www.rotowire.com', 'http', true),
  ('picks-hub-mlb', 'Picks Hub MLB', 'https://pickshub.net', 'http', true),
  ('hotstreak-mlb', 'HotStreak MLB', 'https://www.hotstreak.gg', 'browser', true),
  ('wagergnome-mlb', 'WagerGnome MLB', 'https://www.wagergnome.com', 'http', true),
  ('baseball-prospectus', 'Baseball Prospectus', 'https://www.baseballprospectus.com', 'http', true),
  ('dratings-mlb', 'DRatings MLB', 'https://www.dratings.com', 'http', true)
ON CONFLICT (slug) DO NOTHING;
