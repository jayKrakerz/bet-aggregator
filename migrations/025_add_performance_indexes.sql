-- Performance indexes for critical query paths

-- Speed up predictions queries filtered by sport + date (stats, daily picks)
CREATE INDEX IF NOT EXISTS idx_predictions_sport_created ON predictions(sport, created_at);

-- Speed up grading queries and source accuracy lookups
CREATE INDEX IF NOT EXISTS idx_predictions_grade ON predictions(grade) WHERE grade IS NOT NULL;

-- Speed up source accuracy aggregation (grade + source_id combo)
CREATE INDEX IF NOT EXISTS idx_predictions_source_grade ON predictions(source_id, grade) WHERE grade IS NOT NULL;

-- Speed up match results joins for form/H2H queries
CREATE INDEX IF NOT EXISTS idx_match_results_status ON match_results(status) WHERE status = 'final';

-- Speed up home/away split queries
CREATE INDEX IF NOT EXISTS idx_matches_home_team ON matches(home_team_id);
CREATE INDEX IF NOT EXISTS idx_matches_away_team ON matches(away_team_id);
