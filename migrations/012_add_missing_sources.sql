-- Add source rows for adapters that were missing from the sources table
INSERT INTO sources (slug, name, base_url, fetch_method) VALUES
  ('dunkel-index', 'Dunkel Index', 'https://www.dunkelindex.com', 'http'),
  ('scores-and-odds', 'ScoresAndOdds', 'https://www.scoresandodds.com', 'http'),
  ('cbs-sports', 'CBS Sports', 'https://www.cbssports.com', 'browser'),
  ('bettingpros', 'BettingPros', 'https://www.bettingpros.com', 'browser'),
  ('dimers', 'Dimers', 'https://www.dimers.com', 'browser')
ON CONFLICT (slug) DO NOTHING;
