/**
 * Code Mutation Engine
 *
 * Takes known valid Sportybet booking codes and discovers nearby codes
 * by mutating 1-2 characters. Sportybet codes are clustered — codes
 * created around the same time often differ by just 1-2 characters.
 *
 * Strategy:
 * - Mutate last 2 positions (highest variation in sequential codes)
 * - Validate each mutation against Sportybet API
 * - Rate-limited: max 5 concurrent, 200ms delay between batches
 * - Cache checked codes to avoid re-validation
 */

import { logger } from '../utils/logger.js';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const VALIDATE_URL = 'https://www.sportybet.com/api/ng/orders/share/';
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 100;
const MAX_MUTATIONS_PER_RUN = 80; // keep low for serverless timeout limits

// In-memory cache of already-checked codes (survives warm Vercel instances)
const checkedCodes = new Set<string>();
const validatedMutations = new Map<string, MutatedCode>();

export interface MutatedCode {
  code: string;
  parentCode: string;
  events: number;
  totalOdds: number;
  selections: Array<{
    homeTeam: string;
    awayTeam: string;
    league: string;
    market: string;
    pick: string;
    odds: number;
    matchStatus: string;
    matchDate: string | null;
    estimateStartTime: number | null;
    eventId: string;
    marketId: string;
    outcomeId: string;
    specifier: string;
    sportId: string;
    isWinning: number | null;
    score: string | null;
  }>;
}

/**
 * Generate mutations for a code by changing 1 character at specified positions.
 */
function generateMutations(code: string, positions: number[]): string[] {
  const mutations: string[] = [];
  const upper = code.toUpperCase();

  for (const pos of positions) {
    if (pos < 0 || pos >= upper.length) continue;
    const original = upper[pos]!;
    for (const c of CHARS) {
      if (c === original) continue;
      const mutated = upper.slice(0, pos) + c + upper.slice(pos + 1);
      if (!checkedCodes.has(mutated)) {
        mutations.push(mutated);
      }
    }
  }

  return mutations;
}

/**
 * Validate a single code against Sportybet API.
 * Returns the code data if valid, null otherwise.
 */
async function validateCode(code: string): Promise<MutatedCode | null> {
  checkedCodes.add(code);

  // Check cache first
  if (validatedMutations.has(code)) return validatedMutations.get(code)!;

  try {
    const res = await fetch(VALIDATE_URL + encodeURIComponent(code), {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;

    const data = await res.json() as {
      bizCode: number;
      isAvailable: boolean;
      data?: {
        ticket?: { selections?: Array<{ eventId: string; marketId: string; outcomeId: string; specifier?: string; sportId: string }> };
        outcomes?: Array<{
          eventId: string;
          homeTeamName: string;
          awayTeamName: string;
          setScore?: string;
          matchStatus: string;
          estimateStartTime?: number;
          sport: { id: string; category: { name: string; tournament: { name: string } } };
          markets: Array<{ id: string; specifier?: string; desc: string; outcomes: Array<{ id: string; odds: string; desc: string; isWinning?: number }> }>;
        }>;
      };
    };

    if (data.bizCode !== 10000 || !data.isAvailable || !data.data?.outcomes) return null;

    const selections = [];
    let totalOdds = 1;

    for (const outcome of data.data.outcomes) {
      const market = outcome.markets[0];
      if (!market || !market.outcomes[0]) continue;
      const sel = market.outcomes[0];
      const odds = parseFloat(sel.odds) || 1;
      totalOdds *= odds;

      const ticketSel = data.data.ticket?.selections?.find(
        ts => ts.eventId === outcome.eventId && ts.marketId === market.id,
      );

      let matchDate: string | null = null;
      if (outcome.estimateStartTime) {
        const d = new Date(outcome.estimateStartTime);
        matchDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      selections.push({
        homeTeam: outcome.homeTeamName,
        awayTeam: outcome.awayTeamName,
        league: `${outcome.sport.category.name} - ${outcome.sport.category.tournament.name}`,
        market: market.desc,
        pick: sel.desc,
        odds,
        matchStatus: outcome.matchStatus || 'Unknown',
        matchDate,
        estimateStartTime: outcome.estimateStartTime ?? null,
        eventId: outcome.eventId,
        marketId: market.id,
        outcomeId: sel.id,
        specifier: ticketSel?.specifier || market.specifier || '',
        sportId: outcome.sport.id,
        isWinning: sel.isWinning ?? null,
        score: outcome.setScore || null,
      });
    }

    const result: MutatedCode = {
      code,
      parentCode: '', // set by caller
      events: selections.length,
      totalOdds: Math.round(totalOdds * 100) / 100,
      selections,
    };

    validatedMutations.set(code, result);
    return result;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Discover new codes by mutating seed codes.
 *
 * @param seedCodes - Known valid codes to mutate from
 * @param maxResults - Stop after finding this many new codes
 * @returns Array of newly discovered valid codes
 */
export async function discoverCodes(
  seedCodes: string[],
  maxResults: number = 20,
): Promise<MutatedCode[]> {
  const discovered: MutatedCode[] = [];
  const allMutations: Array<{ code: string; parent: string }> = [];

  // Generate mutations for each seed — last 2 characters only
  for (const seed of seedCodes) {
    const upper = seed.toUpperCase();
    if (upper.length !== 6) continue;
    // Skip if we already checked this seed recently
    if (checkedCodes.has(upper)) continue;
    checkedCodes.add(upper);

    // Positions to mutate: last 2 chars (index 4, 5) — most variation
    const mutations = generateMutations(upper, [4, 5]);
    for (const m of mutations) {
      allMutations.push({ code: m, parent: upper });
    }
  }

  // Shuffle to avoid predictable patterns that might trigger rate limiting
  for (let i = allMutations.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allMutations[i], allMutations[j]] = [allMutations[j]!, allMutations[i]!];
  }

  // Limit total mutations per run
  const toCheck = allMutations.slice(0, MAX_MUTATIONS_PER_RUN);

  logger.info({
    seedCodes: seedCodes.length,
    totalMutations: allMutations.length,
    checking: toCheck.length,
  }, 'Code mutation: starting discovery');

  // Process in batches
  for (let i = 0; i < toCheck.length && discovered.length < maxResults; i += BATCH_SIZE) {
    const batch = toCheck.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(m => validateCode(m.code)),
    );

    for (let j = 0; j < batch.length; j++) {
      const r = results[j]!;
      if (r.status === 'fulfilled' && r.value) {
        r.value.parentCode = batch[j]!.parent;
        // Only keep codes with pending/live selections
        const hasPending = r.value.selections.some(s => s.isWinning === null && s.matchStatus !== 'Ended');
        if (hasPending) {
          discovered.push(r.value);
        }
      }
    }

    // Rate limit delay between batches
    if (i + BATCH_SIZE < toCheck.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  logger.info({
    checked: toCheck.length,
    discovered: discovered.length,
    cacheSize: checkedCodes.size,
  }, 'Code mutation: discovery complete');

  return discovered;
}

/**
 * Get cache stats for monitoring.
 */
export function getMutationStats() {
  return {
    checkedCount: checkedCodes.size,
    validCount: validatedMutations.size,
  };
}
