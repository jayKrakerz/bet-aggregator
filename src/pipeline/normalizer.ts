import type { RawPrediction, NormalizedPrediction } from '../types/prediction.js';
import { resolveOrCreateTeamId } from './team-resolver.js';
import { computeDedupKey } from './dedup.js';
import { findOrCreateMatch, insertPredictionBatch } from '../db/queries.js';
import { logger } from '../utils/logger.js';

export async function normalizeAndInsert(raw: RawPrediction[]): Promise<number> {
  if (!raw.length) return 0;

  // Phase 1: Batch resolve all unique team names upfront
  const uniqueTeams = new Map<string, { sport: string }>();
  for (const pred of raw) {
    const hKey = `${pred.homeTeamRaw.toLowerCase().trim()}|${pred.sport}`;
    const aKey = `${pred.awayTeamRaw.toLowerCase().trim()}|${pred.sport}`;
    if (!uniqueTeams.has(hKey)) uniqueTeams.set(hKey, { sport: pred.sport });
    if (!uniqueTeams.has(aKey)) uniqueTeams.set(aKey, { sport: pred.sport });
  }

  const teamIdCache = new Map<string, number | null>();
  await Promise.all(
    Array.from(uniqueTeams.entries()).map(async ([key, { sport }]) => {
      const rawName = key.split('|')[0]!;
      const id = await resolveOrCreateTeamId(rawName, sport);
      teamIdCache.set(key, id);
    }),
  );

  // Phase 2: Resolve matches and build normalized predictions
  const toInsert: NormalizedPrediction[] = [];

  for (const pred of raw) {
    const hKey = `${pred.homeTeamRaw.toLowerCase().trim()}|${pred.sport}`;
    const aKey = `${pred.awayTeamRaw.toLowerCase().trim()}|${pred.sport}`;
    const homeTeamId = teamIdCache.get(hKey) ?? null;
    const awayTeamId = teamIdCache.get(aKey) ?? null;

    if (!homeTeamId || !awayTeamId) {
      logger.warn(
        { home: pred.homeTeamRaw, away: pred.awayTeamRaw, source: pred.sourceId },
        'Could not resolve team names, skipping prediction',
      );
      continue;
    }

    if (!pred.gameDate) {
      logger.warn({ source: pred.sourceId }, 'Missing game date, skipping prediction');
      continue;
    }

    const matchId = await findOrCreateMatch({
      sport: pred.sport,
      homeTeamId,
      awayTeamId,
      gameDate: pred.gameDate,
      gameTime: pred.gameTime,
    });

    const dedupKey = computeDedupKey({
      sourceId: pred.sourceId,
      matchId,
      pickType: pred.pickType,
      side: pred.side,
      pickerName: pred.pickerName,
    });

    toInsert.push({
      ...pred,
      homeTeamId,
      awayTeamId,
      matchId,
      dedupKey,
    });
  }

  // Phase 3: Batch insert predictions
  if (!toInsert.length) return 0;
  return insertPredictionBatch(toInsert);
}
