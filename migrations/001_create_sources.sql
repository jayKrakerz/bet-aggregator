CREATE TABLE sources (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  fetch_method TEXT NOT NULL CHECK (fetch_method IN ('http', 'browser')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_fetched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO sources (slug, name, base_url, fetch_method) VALUES
  ('covers-com', 'Covers.com', 'https://www.covers.com', 'http'),
  ('oddshark', 'OddsShark', 'https://www.oddsshark.com', 'browser'),
  ('pickswise', 'Pickswise', 'https://www.pickswise.com', 'http');
