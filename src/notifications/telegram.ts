import { request } from 'undici';
import { config } from '../config.js';
import type { ScoredMatch } from '../api/scoring.js';
import { logger } from '../utils/logger.js';

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function formatPick(pick: ScoredMatch, index: number): string {
  const team = pick.recommendation === 'home' ? pick.homeTeam
    : pick.recommendation === 'away' ? pick.awayTeam : 'Draw';
  const emoji = pick.score >= 80 ? '\u{1F525}' : pick.score >= 65 ? '\u{2B50}' : '\u{1F4CA}';

  return [
    `${emoji} *#${index + 1} \\- Score: ${pick.score}/100*`,
    `${escapeMarkdownV2(pick.homeTeam)} vs ${escapeMarkdownV2(pick.awayTeam)}`,
    `Pick: *${escapeMarkdownV2(team)}* \\(${escapeMarkdownV2(pick.pickType)}\\)`,
    `${escapeMarkdownV2(pick.analysis || '')}`,
  ].join('\n');
}

export async function sendTelegramPicks(picks: ScoredMatch[]): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return;

  const header = `\u{1F3AF} *JA EdgeScore \\- Top Picks*\n`;
  const body = picks.map((p, i) => formatPick(p, i)).join('\n\n');
  const footer = `\n\n_Generated at ${escapeMarkdownV2(new Date().toLocaleTimeString())}_`;
  const text = header + body + footer;

  try {
    const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
    await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'MarkdownV2',
      }),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to send Telegram message');
  }
}
