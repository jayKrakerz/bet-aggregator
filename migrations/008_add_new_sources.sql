-- Add 8 new football prediction sources
INSERT INTO sources (slug, name, base_url, fetch_method) VALUES
  ('vitibet', 'Vitibet', 'https://www.vitibet.com', 'http'),
  ('footballpredictions', 'Football Predictions', 'https://footballpredictions.com', 'http'),
  ('topbetpredict', 'TopBetPredict', 'https://topbetpredict.com', 'http'),
  ('predictz', 'Predictz', 'https://www.predictz.com', 'browser'),
  ('statarea', 'StatArea', 'https://old.statarea.com', 'browser'),
  ('eaglepredict', 'EaglePredict', 'https://eaglepredict.com', 'browser'),
  ('windrawwin', 'WinDrawWin', 'https://www.windrawwin.com', 'browser'),
  ('betmines', 'BetMines', 'https://betmines.com', 'browser');
