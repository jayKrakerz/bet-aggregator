-- Fix batch 10 sources: replace dead sites with working ones
-- Update existing rows with new URLs
UPDATE sources SET name = 'SoccerTipz', base_url = 'https://soccertipz.com' WHERE slug = 'soccertipz';
UPDATE sources SET name = 'ForebetTips', base_url = 'https://www.forebettips.com' WHERE slug = 'forebet-tips';
UPDATE sources SET name = 'BettingClosedTips', base_url = 'https://www.bettingclosed.com' WHERE slug = 'bettingclosed-tips';
UPDATE sources SET name = 'ConfirmBets', base_url = 'https://www.confirmbets.com' WHERE slug = 'confirmbets';
UPDATE sources SET name = 'SoccerPredictions365', base_url = 'https://www.soccerpredictions365.com' WHERE slug = 'soccerpredictions365';
UPDATE sources SET name = 'BetGaranteed', base_url = 'https://www.betgaranteed.com' WHERE slug = 'betgaranteed';

-- Replace dead sites with new slugs
-- victorspredict → hellopredict
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES ('hellopredict', 'HelloPredict', 'https://www.hellopredict.com', 'http', true)
ON CONFLICT (slug) DO NOTHING;

-- soccer24x7 → betloy
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES ('betloy', 'BetLoy', 'https://www.betloy.com', 'http', true)
ON CONFLICT (slug) DO NOTHING;

-- predictalot → predictsoccer
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES ('predictsoccer', 'PredictSoccer', 'https://www.predictsoccer.com', 'http', true)
ON CONFLICT (slug) DO NOTHING;

-- tipsscore → tips180
INSERT INTO sources (slug, name, base_url, fetch_method, is_active)
VALUES ('tips180', 'Tips180', 'https://www.tips180.com', 'browser', true)
ON CONFLICT (slug) DO NOTHING;

-- Deactivate old dead slugs
UPDATE sources SET is_active = false WHERE slug IN ('victorspredict', 'soccer24x7', 'predictalot', 'tipsscore');
