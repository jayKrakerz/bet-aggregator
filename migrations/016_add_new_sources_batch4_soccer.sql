-- Add 5 new soccer prediction sources (batch 4)
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES
  ('supatips', 'Supatips', 'https://www.supatips.com', 'http', true),
  ('freesupertips', 'Free Super Tips', 'https://www.freesupertips.com', 'http', true),
  ('adibet', 'Adibet', 'https://www.adibet.com', 'http', true),
  ('zulubet', 'ZuluBet', 'https://www.zulubet.com', 'http', true),
  ('footballsupertips', 'Football Super Tips', 'https://www.footballsuper.tips', 'http', true)
ON CONFLICT (slug) DO NOTHING;
