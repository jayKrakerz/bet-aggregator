-- Delete truly dead sources (0 predictions today and this week)
-- First delete their predictions to avoid FK constraint
DELETE FROM predictions WHERE source_id IN (
  SELECT id FROM sources WHERE slug IN (
    'hellopredict', 'tennis-tips-uk', 'wagergnome', 'soccerstats', 'soccervista',
    'footsuper', 'swish-analytics', 'basketball-insiders', 'numberfire-mlb', 'betshoot',
    'baseball-reference', 'hotstreak-mlb', 'olbg-tennis', 'prosportstips-tennis',
    'rotowire-nba', 'fangraphs', 'overlyzer', 'lineups-mlb', 'hashtagbasketball',
    'sportsline-nba', 'numberfire', 'fantasylabs', 'tennisabstract', 'topbetpredict',
    'soccerway', 'lineups-nba', 'tipstrr', 'betting-expert-tennis', 'mybetting-tennis',
    'nowgoal', 'predictor-bet', 'nba-betting', 'betclan', 'tennis-explorer',
    'confirmbets', 'hotstreak-nba', 'statsinsider-tennis', 'hoopshype', 'picks-hub-mlb',
    'forebet-tips', 'nba-analysis', 'betloy', 'mightytips-nba', 'picks-hub',
    'betmines', 'betsapi-tennis', 'wagergnome-mlb', 'soccertipz', 'mightytips-tennis',
    'footballtipster', 'pivotanalysis', 'mlb-picks-today', 'soccerpredictions365',
    'tennis-predict', 'mightytips-mlb', 'soccer24x7', 'predictalot', 'betgaranteed',
    'footystats', 'tipsscore', 'dunksandthrees', 'clutchpoints', 'bettingclosed',
    'rotowire-mlb', 'tennisstats247', 'baseball-prospectus', 'predictsoccer',
    'dailyfaceoff-mlb', 'closingline', 'soccerpunter', 'victorspredict'
  )
);

-- Then delete the sources
DELETE FROM sources WHERE slug IN (
  'hellopredict', 'tennis-tips-uk', 'wagergnome', 'soccerstats', 'soccervista',
  'footsuper', 'swish-analytics', 'basketball-insiders', 'numberfire-mlb', 'betshoot',
  'baseball-reference', 'hotstreak-mlb', 'olbg-tennis', 'prosportstips-tennis',
  'rotowire-nba', 'fangraphs', 'overlyzer', 'lineups-mlb', 'hashtagbasketball',
  'sportsline-nba', 'numberfire', 'fantasylabs', 'tennisabstract', 'topbetpredict',
  'soccerway', 'lineups-nba', 'tipstrr', 'betting-expert-tennis', 'mybetting-tennis',
  'nowgoal', 'predictor-bet', 'nba-betting', 'betclan', 'tennis-explorer',
  'confirmbets', 'hotstreak-nba', 'statsinsider-tennis', 'hoopshype', 'picks-hub-mlb',
  'forebet-tips', 'nba-analysis', 'betloy', 'mightytips-nba', 'picks-hub',
  'betmines', 'betsapi-tennis', 'wagergnome-mlb', 'soccertipz', 'mightytips-tennis',
  'footballtipster', 'pivotanalysis', 'mlb-picks-today', 'soccerpredictions365',
  'tennis-predict', 'mightytips-mlb', 'soccer24x7', 'predictalot', 'betgaranteed',
  'footystats', 'tipsscore', 'dunksandthrees', 'clutchpoints', 'bettingclosed',
  'rotowire-mlb', 'tennisstats247', 'baseball-prospectus', 'predictsoccer',
  'dailyfaceoff-mlb', 'closingline', 'soccerpunter', 'victorspredict'
);
