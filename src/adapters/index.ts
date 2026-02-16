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

export function getAdapter(id: string): SiteAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`Unknown adapter: ${id}`);
  return adapter;
}

export function getAllAdapters(): SiteAdapter[] {
  return Array.from(adapters.values());
}

export { adapters };
