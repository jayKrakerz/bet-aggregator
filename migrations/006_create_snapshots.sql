CREATE TABLE snapshots (
  id SERIAL PRIMARY KEY,
  source_slug TEXT NOT NULL,
  sport TEXT NOT NULL,
  url TEXT NOT NULL,
  fetch_method TEXT NOT NULL,
  http_status INTEGER,
  duration_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  html_path TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_snapshots_source_slug ON snapshots(source_slug);
CREATE INDEX idx_snapshots_fetched_at ON snapshots(fetched_at);
