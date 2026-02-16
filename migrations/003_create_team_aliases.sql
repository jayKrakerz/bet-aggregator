CREATE TABLE team_aliases (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  alias TEXT NOT NULL,
  UNIQUE (alias, team_id)
);
CREATE INDEX idx_team_aliases_alias ON team_aliases(alias);
