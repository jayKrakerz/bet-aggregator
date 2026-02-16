CREATE TABLE predictions (
  id SERIAL PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  match_id INTEGER NOT NULL REFERENCES matches(id),
  sport TEXT NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  pick_type TEXT NOT NULL CHECK (pick_type IN ('spread', 'moneyline', 'over_under', 'prop', 'parlay')),
  side TEXT NOT NULL CHECK (side IN ('home', 'away', 'over', 'under')),
  value NUMERIC,
  picker_name TEXT NOT NULL,
  confidence TEXT CHECK (confidence IN ('low', 'medium', 'high', 'best_bet')),
  reasoning TEXT,
  dedup_key TEXT NOT NULL UNIQUE,
  fetched_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_predictions_match_id ON predictions(match_id);
CREATE INDEX idx_predictions_source_id ON predictions(source_id);
CREATE INDEX idx_predictions_fetched_at ON predictions(fetched_at);
