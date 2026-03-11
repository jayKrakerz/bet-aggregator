-- Add 5 new prediction sources (batch 3)
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES
  ('sportscapping', 'SportsCapping', 'https://www.sportscapping.com', 'http', true),
  ('profsportspicks', 'Professional Sports Picks', 'https://professionalsportspicks.com', 'http', true),
  ('pickdawgz', 'PickDawgz', 'https://pickdawgz.com', 'http', true),
  ('sportschatplace', 'Sports Chat Place', 'https://sportschatplace.com', 'http', true),
  ('sbr', 'Sportsbook Review', 'https://www.sportsbookreview.com', 'http', true)
ON CONFLICT (slug) DO NOTHING;
