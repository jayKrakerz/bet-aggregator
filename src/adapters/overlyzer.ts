import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Overlyzer adapter.
 *
 * STATUS: BROKEN - /football-predictions/ returns Next.js 404 as of 2026-03-10.
 * The site now uses /en/overunder for prematch data and /en/live for live data.
 * Needs path update to '/en/overunder' or '/en/live'.
 *
 * Overlyzer.com specializes in live football predictions and over/under analysis.
 * The site uses a modern React/SPA architecture but pre-renders some content.
 *
 * Expected page structure:
 * - Match cards in `.match-card` or `.game-row` containers
 * - Each card shows:
 *   - `.home-team` / `.away-team`: team names
 *   - `.match-time`, `.kickoff`: time info
 *   - `.league-name`: competition
 *   - `.over-bar` / `.under-bar`: visual probability bars for O/U
 *   - `.over-pct` / `.under-pct`: percentage values
 *   - `.prediction-badge`: recommended pick
 *   - `.trend-indicator`: current scoring trend
 *
 * Focus: Over/Under predictions with probability bars, plus 1X2 picks.
 * Uses browser fetch as content is often dynamically loaded.
 */
export class OverlyzerAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'overlyzer',
    name: 'Overlyzer',
    baseUrl: 'https://www.overlyzer.com',
    fetchMethod: 'browser',
    paths: {
      football: '/en/overunder',
    },
    cron: '0 0 8,12,16,20 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 8000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('.match-card, .game-row, .match-item, [class*="match-card"]').each((_i, el) => {
      const $el = $(el);

      const homeTeam = $el.find('.home-team, .team-home, [class*="home"]').first().text().trim();
      const awayTeam = $el.find('.away-team, .team-away, [class*="away"]').first().text().trim();
      if (!homeTeam || !awayTeam) return;

      const league = $el.find('.league-name, .league, .competition').text().trim();
      const timeText = $el.find('.match-time, .kickoff, .time').text().trim();
      const gameDate = fetchedAt.toISOString().split('T')[0]!;

      // Over/Under prediction
      const overPctText = $el.find('.over-pct, .over-value, [class*="over-pct"]').text().trim();
      const underPctText = $el.find('.under-pct, .under-value, [class*="under-pct"]').text().trim();
      const overPct = parseInt(overPctText.replace('%', ''), 10);
      const underPct = parseInt(underPctText.replace('%', ''), 10);

      if (!isNaN(overPct) && !isNaN(underPct) && Math.abs(overPct - underPct) >= 10) {
        const ouSide: Side = overPct > underPct ? 'over' : 'under';
        const diff = Math.abs(overPct - underPct);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate,
          gameTime: /\d{1,2}:\d{2}/.test(timeText) ? timeText : null,
          pickType: 'over_under',
          side: ouSide,
          value: 2.5,
          pickerName: 'Overlyzer',
          confidence: this.diffToConfidence(diff),
          reasoning: [league, `Over: ${overPct}%, Under: ${underPct}%`].filter(Boolean).join(' | '),
          fetchedAt,
        });
      }

      // 1X2 prediction if available
      const badge = $el.find('.prediction-badge, .tip, .prediction, [class*="prediction"]').text().trim();
      const side = this.mapTipToSide(badge);
      if (side) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate,
          gameTime: /\d{1,2}:\d{2}/.test(timeText) ? timeText : null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'Overlyzer',
          confidence: null,
          reasoning: league || null,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private mapTipToSide(tip: string): Side | null {
    const t = tip.toUpperCase().trim();
    if (t === '1' || t.includes('HOME')) return 'home';
    if (t === '2' || t.includes('AWAY')) return 'away';
    if (t === 'X' || t.includes('DRAW')) return 'draw';
    return null;
  }

  private diffToConfidence(diff: number): Confidence {
    if (diff >= 40) return 'best_bet';
    if (diff >= 25) return 'high';
    if (diff >= 15) return 'medium';
    return 'low';
  }
}
