-- Add 7 new prediction sources (batch 2)
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES
  ('sportsmemo', 'SportsMemo', 'https://www.sportsmemo.com', 'http', true),
  ('cappertek', 'CapperTek', 'https://www.cappertek.com', 'http', true),
  ('picksandparlays', 'Picks & Parlays', 'https://picksandparlays.net', 'http', true),
  ('predictem', 'PredictEm', 'https://www.predictem.com', 'http', true),
  ('winnersandwhiners', 'Winners & Whiners', 'https://winnersandwhiners.com', 'http', true),
  ('boydsbets', 'Boyd''s Bets', 'https://www.boydsbets.com', 'http', true),
  ('scoresandstats', 'Scores & Stats', 'https://www.scoresandstats.com', 'browser', true)
ON CONFLICT (slug) DO NOTHING;
