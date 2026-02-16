-- Expand side CHECK constraint to support football predictions (draw, yes/no for BTTS)
ALTER TABLE predictions DROP CONSTRAINT predictions_side_check;
ALTER TABLE predictions ADD CONSTRAINT predictions_side_check
  CHECK (side IN ('home', 'away', 'over', 'under', 'draw', 'yes', 'no'));

-- Add onemillionpredictions source
INSERT INTO sources (slug, name, base_url, fetch_method) VALUES
  ('onemillionpredictions', 'OneMillionPredictions', 'https://onemillionpredictions.com', 'browser');
