-- Match results table for tracking actual game outcomes
CREATE TABLE match_results (
  id SERIAL PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) UNIQUE,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('final', 'postponed', 'cancelled')) DEFAULT 'final',
  result_source TEXT NOT NULL DEFAULT 'espn',
  settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_match_results_match_id ON match_results(match_id);

-- Add grading columns to predictions
ALTER TABLE predictions ADD COLUMN grade TEXT CHECK (grade IN ('win', 'loss', 'push', 'void'));
ALTER TABLE predictions ADD COLUMN graded_at TIMESTAMPTZ;
CREATE INDEX idx_predictions_grade ON predictions(grade);
