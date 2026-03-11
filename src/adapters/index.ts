import type { SiteAdapter } from '../types/adapter.js';
import { CoversComAdapter } from './covers-com.js';
import { OddSharkAdapter } from './oddshark.js';
import { PickswiseAdapter } from './pickswise.js';
import { OneMillionPredictionsAdapter } from './onemillionpredictions.js';
import { OddsTraderAdapter } from './oddstrader.js';
import { ForebetAdapter } from './forebet.js';
import { DunkelIndexAdapter } from './dunkel-index.js';
import { ScoresAndOddsAdapter } from './scores-and-odds.js';
import { CbsSportsAdapter } from './cbs-sports.js';
import { BettingProsAdapter } from './bettingpros.js';
import { DimersAdapter } from './dimers.js';
import { VitibetAdapter } from './vitibet.js';
import { FootballPredictionsAdapter } from './footballpredictions.js';
// TopBetPredict removed — site is blog-only, no structured predictions
import { PredictzAdapter } from './predictz.js';
import { StatAreaAdapter } from './statarea.js';
import { EaglePredictAdapter } from './eaglepredict.js';
import { WinDrawWinAdapter } from './windrawwin.js';
import { SportsAiAdapter } from './sports-ai.js';
import { ActionNetworkAdapter } from './action-network.js';
import { ProSoccerAdapter } from './prosoccer.js';
import { SoccerEcoAdapter } from './soccereco.js';
import { WagerTalkAdapter } from './wagertalk.js';
import { DocsSportsAdapter } from './docsports.js';
import { SportsMemoAdapter } from './sportsmemo.js';
import { CapperTekAdapter } from './cappertek.js';
import { PicksAndParlaysAdapter } from './picksandparlays.js';
import { PredictEmAdapter } from './predictem.js';
import { WinnersAndWhinersAdapter } from './winnersandwhiners.js';
import { BoydsBetsAdapter } from './boydsbets.js';
import { ScoresAndStatsAdapter } from './scoresandstats.js';
import { SportsCappingAdapter } from './sportscapping.js';
import { ProfSportsPicksAdapter } from './profsportspicks.js';
import { PickDawgzAdapter } from './pickdawgz.js';
import { SportsChatPlaceAdapter } from './sportschatplace.js';
import { SbrAdapter } from './sbr.js';
import { SupatipsAdapter } from './supatips.js';
import { FreeSuperTipsAdapter } from './freesupertips.js';
import { AdibetAdapter } from './adibet.js';
import { ZuluBetAdapter } from './zulubet.js';
import { FootballSuperTipsAdapter } from './footballsupertips.js';
// BetMines disabled — Cloudflare blocks even Playwright; revisit with stealth plugin
// import { BetMinesAdapter } from './betmines.js';

// --- Tennis adapters ---
import { TennisPredictAdapter } from './tennis-predict.js';
import { TennisExplorerAdapter } from './tennis-explorer.js';
import { SofascoreTennisAdapter } from './sofascore-tennis.js';
import { FlashscoreTennisAdapter } from './flashscore-tennis.js';
import { BettingExpertTennisAdapter } from './betting-expert-tennis.js';
import { TennisTipsUkAdapter } from './tennis-tips-uk.js';
import { OlbgTennisAdapter } from './olbg-tennis.js';
import { BetIdeasTennisAdapter } from './betideas-tennis.js';
import { MyBettingTennisAdapter } from './mybetting-tennis.js';
import { MightyTipsTennisAdapter } from './mightytips-tennis.js';
import { StatsInsiderTennisAdapter } from './statsinsider-tennis.js';
import { TennisStats247Adapter } from './tennisstats247.js';
import { ProSportsTipsTennisAdapter } from './prosportstips-tennis.js';
import { BetsApiTennisAdapter } from './betsapi-tennis.js';

// --- Additional soccer adapters ---
import { BetensuredAdapter } from './betensured.js';
import { SoccervistaAdapter } from './soccervista.js';
import { BetshootAdapter } from './betshoot.js';
import { FootsuperAdapter } from './footsuper.js';
import { MybetsSoccerAdapter } from './mybets-soccer.js';
import { TipstrrAdapter } from './tipstrr.js';
import { OverlyzerAdapter } from './overlyzer.js';
import { BetclanAdapter } from './betclan.js';
import { FootballtipsterAdapter } from './footballtipster.js';
import { BettingclosedAdapter } from './bettingclosed.js';
import { PredictorBetAdapter } from './predictor-bet.js';
import { FootystatsAdapter } from './footystats.js';
import { SoccerwayAdapter } from './soccerway.js';
import { GoalooAdapter } from './goaloo.js';
import { NowgoalAdapter } from './nowgoal.js';
import { BetExplorerAdapter } from './betexplorer.js';
import { OddsPortalAdapter } from './oddsportal.js';
import { TotalCornerAdapter } from './totalcorner.js';
import { SoccerPunterAdapter } from './soccerpunter.js';
import { SoccerStatsAdapter } from './soccerstats.js';
import { BettingExpertAdapter } from './bettingexpert.js';
import { FlashscoreSoccerAdapter } from './flashscore-soccer.js';

// --- Additional NBA adapters ---
import { NumberfireAdapter } from './numberfire.js';
import { BasketballReferenceAdapter } from './basketball-reference.js';
import { SwishAnalyticsAdapter } from './swish-analytics.js';
import { LineupsNbaAdapter } from './lineups-nba.js';
import { NbaAnalysisAdapter } from './nba-analysis.js';
import { ClutchPointsAdapter } from './clutchpoints.js';
import { SportslineNbaAdapter } from './sportsline-nba.js';
import { MightytipsNbaAdapter } from './mightytips-nba.js';
import { HoopshypeAdapter } from './hoopshype.js';
import { NbaBettingAdapter } from './nba-betting.js';
import { BasketballInsidersAdapter } from './basketball-insiders.js';
import { PicksHubAdapter } from './picks-hub.js';
import { WagergnomeAdapter } from './wagergnome.js';
import { BetqlNbaAdapter } from './betql-nba.js';
import { HotstreakNbaAdapter } from './hotstreak-nba.js';

// --- Additional MLB adapters ---
import { BaseballReferenceAdapter } from './baseball-reference.js';
import { FangraphsAdapter } from './fangraphs.js';
import { MlbPicksTodayAdapter } from './mlb-picks-today.js';
import { MightyTipsMlbAdapter } from './mightytips-mlb.js';
import { NumberfireMlbAdapter } from './numberfire-mlb.js';
import { SportslineMlbAdapter } from './sportsline-mlb.js';
import { LineupsMlbAdapter } from './lineups-mlb.js';
import { BetqlMlbAdapter } from './betql-mlb.js';
import { BaseballSavantAdapter } from './baseball-savant.js';
import { RotowireMlbAdapter } from './rotowire-mlb.js';
import { PicksHubMlbAdapter } from './picks-hub-mlb.js';
import { HotStreakMlbAdapter } from './hotstreak-mlb.js';
import { WagerGnomeMlbAdapter } from './wagergnome-mlb.js';
import { BaseballProspectusAdapter } from './baseball-prospectus.js';
import { DRatingsMlbAdapter } from './dratings-mlb.js';

// --- New tennis/multi adapters ---
import { TennisAbstractAdapter } from './tennisabstract.js';
import { OddsCheckerTennisAdapter } from './oddschecker-tennis.js';
import { SofascoreNbaAdapter } from './sofascore-nba.js';
import { FlashscoreNbaAdapter } from './flashscore-nba.js';
import { OddsCheckerNbaAdapter } from './oddschecker-nba.js';
import { OddsCheckerMlbAdapter } from './oddschecker-mlb.js';
import { FlashscoreMlbAdapter } from './flashscore-mlb.js';

// --- New NBA adapters ---
import { HashtagBasketballAdapter } from './hashtagbasketball.js';
import { DunksAndThreesAdapter } from './dunksandthrees.js';
import { PivotAnalysisAdapter } from './pivotanalysis.js';
import { RotowireNbaAdapter } from './rotowire-nba.js';
import { FantasyLabsAdapter } from './fantasylabs.js';

// --- New MLB adapters ---
import { ClosingLineAdapter } from './closingline.js';
import { DailyFaceoffMlbAdapter } from './dailyfaceoff-mlb.js';

const adapters: Map<string, SiteAdapter> = new Map();

function register(adapter: SiteAdapter): void {
  adapters.set(adapter.config.id, adapter);
}

register(new CoversComAdapter());
register(new OddSharkAdapter());
register(new PickswiseAdapter());
register(new OneMillionPredictionsAdapter());
register(new OddsTraderAdapter());
register(new ForebetAdapter());
register(new DunkelIndexAdapter());
register(new ScoresAndOddsAdapter());
register(new CbsSportsAdapter());
register(new BettingProsAdapter());
register(new DimersAdapter());
register(new VitibetAdapter());
register(new FootballPredictionsAdapter());
// TopBetPredict removed — site no longer has predictions
register(new PredictzAdapter());
register(new StatAreaAdapter());
register(new EaglePredictAdapter());
register(new WinDrawWinAdapter());
register(new SportsAiAdapter());
register(new ActionNetworkAdapter());
register(new ProSoccerAdapter());
register(new SoccerEcoAdapter());
register(new WagerTalkAdapter());
register(new DocsSportsAdapter());
register(new SportsMemoAdapter());
register(new CapperTekAdapter());
register(new PicksAndParlaysAdapter());
register(new PredictEmAdapter());
register(new WinnersAndWhinersAdapter());
register(new BoydsBetsAdapter());
register(new ScoresAndStatsAdapter());
register(new SportsCappingAdapter());
register(new ProfSportsPicksAdapter());
register(new PickDawgzAdapter());
register(new SportsChatPlaceAdapter());
register(new SbrAdapter());
register(new SupatipsAdapter());
register(new FreeSuperTipsAdapter());
register(new AdibetAdapter());
register(new ZuluBetAdapter());
register(new FootballSuperTipsAdapter());
// register(new BetMinesAdapter()); // Cloudflare blocks even Playwright

// --- Tennis ---
// register(new TennisPredictAdapter()); // 404
// register(new TennisExplorerAdapter()); // 404
register(new SofascoreTennisAdapter());
register(new FlashscoreTennisAdapter());
register(new BettingExpertTennisAdapter());
// register(new TennisTipsUkAdapter()); // DNS dead: tennistips.co.uk
// register(new OlbgTennisAdapter()); // 404
register(new BetIdeasTennisAdapter());
// register(new MyBettingTennisAdapter()); // Empty response
// register(new MightyTipsTennisAdapter()); // 404
register(new StatsInsiderTennisAdapter());
register(new TennisStats247Adapter());
// register(new ProSportsTipsTennisAdapter()); // DNS dead
register(new BetsApiTennisAdapter());

// --- Additional soccer ---
register(new BetensuredAdapter());
// register(new SoccervistaAdapter()); // 404
// register(new BetshootAdapter()); // Cloudflare challenge
// register(new FootsuperAdapter()); // DNS dead: footsuper.com
register(new MybetsSoccerAdapter());
// register(new TipstrrAdapter()); // 404
register(new OverlyzerAdapter());
// register(new BetclanAdapter()); // 404
// register(new FootballtipsterAdapter()); // No prediction page found
// register(new BettingclosedAdapter()); // 404
// register(new PredictorBetAdapter()); // 404
register(new FootystatsAdapter());
// register(new SoccerwayAdapter()); // Blank/broken page
register(new GoalooAdapter());
register(new NowgoalAdapter());
register(new BetExplorerAdapter());
register(new OddsPortalAdapter());
register(new TotalCornerAdapter());
register(new SoccerPunterAdapter());
register(new SoccerStatsAdapter());
register(new BettingExpertAdapter());
register(new FlashscoreSoccerAdapter());

// --- Additional NBA ---
// register(new NumberfireAdapter()); // CloudFront 403 blocked
register(new BasketballReferenceAdapter());
// register(new SwishAnalyticsAdapter()); // 404
// register(new LineupsNbaAdapter()); // Cloudflare challenge
// register(new NbaAnalysisAdapter()); // 404
// register(new ClutchPointsAdapter()); // 404
register(new SportslineNbaAdapter());
// register(new MightytipsNbaAdapter()); // 404
// register(new HoopshypeAdapter()); // 404
// register(new NbaBettingAdapter()); // DNS dead: nba-betting.net
// register(new BasketballInsidersAdapter()); // 404
// register(new PicksHubAdapter()); // DNS dead: pickshub.net
// register(new WagergnomeAdapter()); // DNS dead: wagergnome.com
register(new BetqlNbaAdapter());
// register(new HotstreakNbaAdapter()); // 404
register(new HashtagBasketballAdapter());
register(new DunksAndThreesAdapter());
register(new PivotAnalysisAdapter());
register(new RotowireNbaAdapter());
register(new FantasyLabsAdapter());

// --- Additional MLB ---
register(new BaseballReferenceAdapter());
register(new FangraphsAdapter());
// register(new MlbPicksTodayAdapter()); // DNS dead: mlbpickstoday.com
// register(new MightyTipsMlbAdapter()); // 404
// register(new NumberfireMlbAdapter()); // CloudFront 403 blocked
register(new SportslineMlbAdapter());
register(new LineupsMlbAdapter());
register(new BetqlMlbAdapter());
register(new BaseballSavantAdapter());
// register(new RotowireMlbAdapter()); // 404
// register(new PicksHubMlbAdapter()); // DNS dead: pickshub.net
// register(new HotStreakMlbAdapter()); // Empty snapshot
// register(new WagerGnomeMlbAdapter()); // DNS dead: wagergnome.com
// register(new BaseballProspectusAdapter()); // 404
register(new DRatingsMlbAdapter());
register(new ClosingLineAdapter());
register(new DailyFaceoffMlbAdapter());
register(new FlashscoreMlbAdapter());
register(new OddsCheckerMlbAdapter());

// --- Tennis/multi ---
register(new TennisAbstractAdapter());
register(new OddsCheckerTennisAdapter());
register(new SofascoreNbaAdapter());
register(new FlashscoreNbaAdapter());
register(new OddsCheckerNbaAdapter());

export function getAdapter(id: string): SiteAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`Unknown adapter: ${id}`);
  return adapter;
}

export function getAllAdapters(): SiteAdapter[] {
  return Array.from(adapters.values());
}

export { adapters };
