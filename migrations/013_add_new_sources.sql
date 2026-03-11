-- Add source rows for new adapters: Action Network, ProSoccer.gr, SoccerEco, WagerTalk, Doc's Sports
INSERT INTO sources (slug, name, base_url, fetch_method) VALUES
  ('action-network', 'Action Network', 'https://www.actionnetwork.com', 'http'),
  ('prosoccer', 'ProSoccer.gr', 'https://www.prosoccer.gr', 'http'),
  ('soccereco', 'SoccerEco', 'https://www.soccereco.com', 'http'),
  ('wagertalk', 'WagerTalk', 'https://www.wagertalk.com', 'browser'),
  ('docsports', 'Doc''s Sports', 'https://www.docsports.com', 'http')
ON CONFLICT (slug) DO NOTHING;
