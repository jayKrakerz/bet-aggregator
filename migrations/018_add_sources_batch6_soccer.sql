-- Add additional soccer prediction sources (batch 6)
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES
  ('betensured', 'Betensured', 'https://www.betensured.com', 'http', true),
  ('soccervista', 'SoccerVista', 'https://www.soccervista.com', 'http', true),
  ('betshoot', 'BetShoot', 'https://www.betshoot.com', 'http', true),
  ('footsuper', 'FootSuper', 'https://www.footsuper.com', 'http', true),
  ('mybets-soccer', 'MyBets Today', 'https://mybets.today', 'http', true),
  ('tipstrr', 'Tipstrr', 'https://www.tipstrr.com', 'http', true),
  ('overlyzer', 'Overlyzer', 'https://www.overlyzer.com', 'browser', true),
  ('betclan', 'BetClan', 'https://www.betclan.com', 'http', true),
  ('footballtipster', 'Football Tipster', 'https://www.footballtipster.net', 'http', true),
  ('bettingclosed', 'BettingClosed', 'https://www.bettingclosed.com', 'http', true),
  ('predictor-bet', 'Predictor', 'https://predictor.bet', 'http', true),
  ('footystats', 'FootyStats', 'https://www.footystats.org', 'http', true),
  ('soccerway', 'Soccerway', 'https://www.soccerway.com', 'http', true),
  ('goaloo', 'Goaloo', 'https://www.goaloo.com', 'http', true),
  ('nowgoal', 'NowGoal', 'https://www.nowgoal.co', 'http', true)
ON CONFLICT (slug) DO NOTHING;
