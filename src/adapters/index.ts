import type { SiteAdapter } from '../types/adapter.js';

// --- Core adapters (producing predictions) ---
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

// --- Tennis ---
import { SofascoreTennisAdapter } from './sofascore-tennis.js';
import { FlashscoreTennisAdapter } from './flashscore-tennis.js';
import { BetIdeasTennisAdapter } from './betideas-tennis.js';
import { OddsCheckerTennisAdapter } from './oddschecker-tennis.js';

// --- Soccer ---
import { BetensuredAdapter } from './betensured.js';
import { MybetsSoccerAdapter } from './mybets-soccer.js';
import { GoalooAdapter } from './goaloo.js';
import { BetExplorerAdapter } from './betexplorer.js';
import { OddsPortalAdapter } from './oddsportal.js';
import { TotalCornerAdapter } from './totalcorner.js';
import { BettingExpertAdapter } from './bettingexpert.js';
import { FlashscoreSoccerAdapter } from './flashscore-soccer.js';
import { BettingClosedTipsAdapter } from './bettingclosed-tips.js';
import { TipsScoreAdapter as Tips180Adapter } from './tipsscore.js';

// --- NBA ---
import { BasketballReferenceAdapter } from './basketball-reference.js';
import { BetqlNbaAdapter } from './betql-nba.js';
import { SofascoreNbaAdapter } from './sofascore-nba.js';
import { FlashscoreNbaAdapter } from './flashscore-nba.js';
import { OddsCheckerNbaAdapter } from './oddschecker-nba.js';

// --- MLB ---
import { SportslineMlbAdapter } from './sportsline-mlb.js';
import { BetqlMlbAdapter } from './betql-mlb.js';
import { BaseballSavantAdapter } from './baseball-savant.js';
import { DRatingsMlbAdapter } from './dratings-mlb.js';
import { FlashscoreMlbAdapter } from './flashscore-mlb.js';
import { OddsCheckerMlbAdapter } from './oddschecker-mlb.js';

const adapters: Map<string, SiteAdapter> = new Map();

function register(adapter: SiteAdapter): void {
  adapters.set(adapter.config.id, adapter);
}

// --- Core ---
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

// --- Tennis ---
register(new SofascoreTennisAdapter());
register(new FlashscoreTennisAdapter());
register(new BetIdeasTennisAdapter());
register(new OddsCheckerTennisAdapter());

// --- Soccer ---
register(new BetensuredAdapter());
register(new MybetsSoccerAdapter());
register(new GoalooAdapter());
register(new BetExplorerAdapter());
register(new OddsPortalAdapter());
register(new TotalCornerAdapter());
register(new BettingExpertAdapter());
register(new FlashscoreSoccerAdapter());
register(new BettingClosedTipsAdapter());
register(new Tips180Adapter());

// --- NBA ---
register(new BasketballReferenceAdapter());
register(new BetqlNbaAdapter());
register(new SofascoreNbaAdapter());
register(new FlashscoreNbaAdapter());
register(new OddsCheckerNbaAdapter());

// --- MLB ---
register(new SportslineMlbAdapter());
register(new BetqlMlbAdapter());
register(new BaseballSavantAdapter());
register(new DRatingsMlbAdapter());
register(new FlashscoreMlbAdapter());
register(new OddsCheckerMlbAdapter());

export function getAdapter(id: string): SiteAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`Unknown adapter: ${id}`);
  return adapter;
}

export function getAllAdapters(): SiteAdapter[] {
  return Array.from(adapters.values());
}

export { adapters };
