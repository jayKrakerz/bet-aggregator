-- Add 10 new soccer prediction sources (batch 10)
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES
  ('soccertipz', 'SoccerTipz', 'https://www.soccertipz.net', 'http', true),
  ('forebet-tips', 'ForebetTips', 'https://www.forebettips.com', 'http', true),
  ('victorspredict', 'VictorsPredict', 'https://www.victorspredict.com', 'http', true),
  ('soccer24x7', 'Soccer24x7', 'https://www.soccer24x7.com', 'http', true),
  ('betgaranteed', 'BetGaranteed', 'https://www.betgaranteed.com', 'http', true),
  ('confirmbets', 'ConfirmBets', 'https://www.confirmbets.com', 'http', true),
  ('bettingclosed-tips', 'BettingClosedTips', 'https://www.bettingclosed.com', 'http', true),
  ('predictalot', 'PredictALot', 'https://www.predictalot.com', 'http', true),
  ('tipsscore', 'TipsScore', 'https://www.tipsscore.com', 'http', true),
  ('soccerpredictions365', 'SoccerPredictions365', 'https://www.soccerpredictions365.com', 'http', true)
ON CONFLICT (slug) DO NOTHING;
