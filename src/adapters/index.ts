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
// BetMines disabled — Cloudflare blocks even Playwright; revisit with stealth plugin
// import { BetMinesAdapter } from './betmines.js';

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
// register(new BetMinesAdapter()); // Cloudflare blocks even Playwright

export function getAdapter(id: string): SiteAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`Unknown adapter: ${id}`);
  return adapter;
}

export function getAllAdapters(): SiteAdapter[] {
  return Array.from(adapters.values());
}

export { adapters };
