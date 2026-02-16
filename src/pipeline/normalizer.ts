import type { RawPrediction } from '../types/prediction.js';
import { resolveTeamId } from './team-resolver.js';
import { computeDedupKey } from './dedup.js';
import { findOrCreateMatch, insertPrediction } from '../db/queries.js';
import { logger } from '../utils/logger.js';

export async function normalizeAndInsert(raw: RawPrediction[]): Promise<number> {
  let inserted = 0;

  for (const pred of raw) {
    const homeTeamId = resolveTeamId(pred.homeTeamRaw);
    const awayTeamId = resolveTeamId(pred.awayTeamRaw);

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

    const didInsert = await insertPrediction({
      ...pred,
      homeTeamId,
      awayTeamId,
      matchId,
      dedupKey,
    });

    if (didInsert) inserted++;
  }

  return inserted;
}
