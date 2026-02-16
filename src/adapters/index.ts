import type { SiteAdapter } from '../types/adapter.js';
import { CoversComAdapter } from './covers-com.js';
import { OddSharkAdapter } from './oddshark.js';
import { PickswiseAdapter } from './pickswise.js';
import { OneMillionPredictionsAdapter } from './onemillionpredictions.js';

const adapters: Map<string, SiteAdapter> = new Map();

function register(adapter: SiteAdapter): void {
  adapters.set(adapter.config.id, adapter);
}

register(new CoversComAdapter());
register(new OddSharkAdapter());
register(new PickswiseAdapter());
register(new OneMillionPredictionsAdapter());

export function getAdapter(id: string): SiteAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`Unknown adapter: ${id}`);
  return adapter;
}

export function getAllAdapters(): SiteAdapter[] {
  return Array.from(adapters.values());
}

export { adapters };
