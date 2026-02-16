import crypto from 'node:crypto';

/**
 * Generates a deterministic dedup key for a prediction.
 * Same source + match + pick type + side + picker on the same day = same key.
 */
export function computeDedupKey(p: {
  sourceId: string;
  matchId: number;
  pickType: string;
  side: string;
  pickerName: string;
}): string {
  const raw = `${p.sourceId}|${p.matchId}|${p.pickType}|${p.side}|${p.pickerName.toLowerCase().trim()}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}
