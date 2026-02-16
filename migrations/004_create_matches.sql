CREATE TABLE matches (
  id SERIAL PRIMARY KEY,
  sport TEXT NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  game_date DATE NOT NULL,
  game_time TEXT,
  external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sport, home_team_id, away_team_id, game_date)
);
CREATE INDEX idx_matches_game_date ON matches(game_date);
CREATE INDEX idx_matches_sport_date ON matches(sport, game_date);
