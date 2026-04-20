/**
 * Telegram broadcaster — fire-and-forget pick alerts to a channel.
 *
 * Only emits when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are configured.
 * Dedupes by pick key for 6h so the same late-lock doesn't spam as its
 * cache rotates.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const TG_API = 'https://api.telegram.org';
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const sent = new Map<string, number>();

export interface BroadcastPick {
  eventId: string;
  marketId: string;
  outcomeId: string;
  specifier?: string;
  home: string;
  away: string;
  league?: string;
  market: string;
  pick: string;
  odds: number;
  evPct: number;
  score?: string;
  minute?: string | null;
  source: 'late-lock' | 'live-value' | 'dropping-odds';
}

function enabled(): boolean {
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);
}

function pickKey(p: BroadcastPick): string {
  return `${p.source}:${p.eventId}:${p.marketId}:${p.outcomeId}:${p.specifier ?? ''}`;
}

function prune(now: number) {
  for (const [k, t] of sent) if (now - t > DEDUPE_TTL_MS) sent.delete(k);
}

function format(p: BroadcastPick): string {
  const esc = (s: string) => s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, m => `\\${m}`);
  const tag = p.source === 'late-lock' ? '🔒 LATE LOCK' : p.source === 'live-value' ? '⚡ LIVE VALUE' : '📉 STEAM MOVE';
  const state = p.minute ? `${p.score ?? ''} ${esc(p.minute)}'` : '';
  return [
    `*${tag}* — *+${p.evPct.toFixed(1)}% EV*`,
    `${esc(p.home)} vs ${esc(p.away)}${p.league ? ` · _${esc(p.league)}_` : ''}`,
    state && `${esc(state.trim())}`,
    `*${esc(p.market)}*: ${esc(p.pick)} @ \`${p.odds.toFixed(2)}\``,
  ].filter(Boolean).join('\n');
}

export function broadcastPick(p: BroadcastPick): void {
  if (!enabled()) return;
  if (p.evPct < config.TELEGRAM_MIN_EV_PCT) return;
  const now = Date.now();
  prune(now);
  const k = pickKey(p);
  if (sent.has(k)) return;
  sent.set(k, now);

  void fetch(`${TG_API}/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.TELEGRAM_CHAT_ID,
      text: format(p),
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(err => logger.debug({ err }, 'telegram broadcast failed'));
}

export function broadcastPicks(picks: BroadcastPick[]): void {
  if (!enabled()) return;
  for (const p of picks) broadcastPick(p);
}
