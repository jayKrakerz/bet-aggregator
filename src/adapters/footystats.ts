import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * FootyStats adapter.
 *
 * STATUS: BLOCKED BY CLOUDFLARE - /predictions/ returns a Cloudflare Turnstile
 * challenge page even with browser fetch as of 2026-03-10. All snapshots contain
 * only the challenge HTML, no game data. This adapter cannot produce predictions
 * until Cloudflare is bypassed (e.g., via authenticated session or API).
 *
 * Footystats.org provides data-driven football stats and predictions.
 *
 * Expected page structure:
 * - Predictions page with match rows in `.match-row` or `table.predictions tbody tr`
 * - Each match shows:
 *   - `.home-team` / `.away-team`: team names with links
 *   - `.match-date`: date in DD Mon YYYY format
 *   - `.match-time`: kickoff time
 *   - `.league-name`: competition with country
 *   - `.stat-1`, `.stat-x`, `.stat-2`: 1X2 probability percentages
 *   - `.btts-yes`, `.btts-no`: BTTS probabilities
 *   - `.over-25`, `.under-25`: Over/Under 2.5 goals probabilities
 *   - `.prediction`: recommended pick
 *   - `.confidence-meter`: visual confidence indicator (1-5 bars)
 *
 * FootyStats is data-heavy; predictions include comprehensive stats context.
 * Content is server-rendered but may use lazy loading for stats details.
 */
export class FootystatsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'footystats',
    name: 'FootyStats',
    baseUrl: 'https://footystats.org',
    fetchMethod: 'browser',
    paths: {
      football: '/predictions/',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('.match-row, .prediction-row, table.predictions tbody tr').each((_i, el) => {
      const $el = $(el);

      // Extract teams
      let homeTeam = $el.find('.home-team, .team-home').text().trim();
      let awayTeam = $el.find('.away-team, .team-away').text().trim();

      // Table fallback: cells
      if (!homeTeam || !awayTeam) {
        const cells = $el.find('td');
        if (cells.length >= 5) {
          homeTeam = $(cells[1]).text().trim();
          awayTeam = $(cells[2]).text().trim();
        }
      }
      if (!homeTeam || !awayTeam) return;

      // 1X2 probabilities
      const p1 = this.extractPct($el.find('.stat-1, .prob-home, [data-stat="1"]').text());
      const pX = this.extractPct($el.find('.stat-x, .prob-draw, [data-stat="x"]').text());
      const p2 = this.extractPct($el.find('.stat-2, .prob-away, [data-stat="2"]').text());

      // Over/Under 2.5
      const over25 = this.extractPct($el.find('.over-25, .over, [data-stat="over25"]').text());
      const under25 = this.extractPct($el.find('.under-25, .under, [data-stat="under25"]').text());

      // Prediction tip
      const tipText = $el.find('.prediction, .tip, .pick').text().trim();
      const { side, pickType } = this.parseTip(tipText, p1, pX, p2);
      if (!side) return;

      // Context
      const league = $el.find('.league-name, .league, .competition').text().trim();
      const dateText = $el.find('.match-date, .date').text().trim();
      const timeText = $el.find('.match-time, .time').text().trim();

      // Confidence from meter or probabilities
      const bars = $el.find('.confidence-meter .active, .confidence-bar .filled').length;
      const confidence = bars > 0
        ? this.barsToConfidence(bars)
        : this.probsToConfidence(p1, pX, p2, side);

      const gameDate = this.extractDate(dateText, fetchedAt);

      // 1X2 prediction
      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate,
        gameTime: /\d{1,2}:\d{2}/.test(timeText) ? timeText : null,
        pickType,
        side,
        value: pickType === 'over_under' ? this.extractTotal(tipText) : null,
        pickerName: 'FootyStats',
        confidence,
        reasoning: [
          league,
          !isNaN(p1) && !isNaN(pX) && !isNaN(p2) ? `1X2: ${p1}/${pX}/${p2}` : '',
          !isNaN(over25) ? `O2.5: ${over25}%` : '',
        ].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });

      // Add over/under prediction if probabilities diverge
      if (!isNaN(over25) && !isNaN(under25) && Math.abs(over25 - under25) >= 10) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate,
          gameTime: /\d{1,2}:\d{2}/.test(timeText) ? timeText : null,
          pickType: 'over_under',
          side: over25 > under25 ? 'over' : 'under',
          value: 2.5,
          pickerName: 'FootyStats',
          confidence: this.diffToConfidence(Math.abs(over25 - under25)),
          reasoning: `${league} | O2.5: ${over25}%, U2.5: ${under25}%`,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private extractPct(text: string): number {
    const match = text.trim().match(/(\d+(?:\.\d+)?)/);
    return match ? parseFloat(match[1]!) : NaN;
  }

  private parseTip(
    text: string, p1: number, pX: number, p2: number,
  ): { side: Side | null; pickType: 'moneyline' | 'over_under' } {
    const t = text.toUpperCase().trim();
    if (t.includes('OVER')) return { side: 'over', pickType: 'over_under' };
    if (t.includes('UNDER')) return { side: 'under', pickType: 'over_under' };
    if (t === '1' || t.includes('HOME')) return { side: 'home', pickType: 'moneyline' };
    if (t === '2' || t.includes('AWAY')) return { side: 'away', pickType: 'moneyline' };
    if (t === 'X' || t.includes('DRAW')) return { side: 'draw', pickType: 'moneyline' };

    // Fallback: use highest probability
    if (!isNaN(p1) && !isNaN(pX) && !isNaN(p2)) {
      const max = Math.max(p1, pX, p2);
      if (max === p1) return { side: 'home', pickType: 'moneyline' };
      if (max === p2) return { side: 'away', pickType: 'moneyline' };
      return { side: 'draw', pickType: 'moneyline' };
    }
    return { side: null, pickType: 'moneyline' };
  }

  private extractTotal(text: string): number | null {
    const match = text.match(/([\d.]+)/);
    return match ? parseFloat(match[1]!) : 2.5;
  }

  private probsToConfidence(p1: number, pX: number, p2: number, side: Side): Confidence | null {
    if (isNaN(p1) || isNaN(pX) || isNaN(p2)) return null;
    let prob: number;
    if (side === 'home') prob = p1;
    else if (side === 'draw') prob = pX;
    else prob = p2;

    if (prob >= 70) return 'best_bet';
    if (prob >= 55) return 'high';
    if (prob >= 40) return 'medium';
    return 'low';
  }

  private barsToConfidence(bars: number): Confidence {
    if (bars >= 5) return 'best_bet';
    if (bars >= 4) return 'high';
    if (bars >= 3) return 'medium';
    return 'low';
  }

  private diffToConfidence(diff: number): Confidence {
    if (diff >= 40) return 'best_bet';
    if (diff >= 25) return 'high';
    if (diff >= 15) return 'medium';
    return 'low';
  }

  private extractDate(text: string, fetchedAt: Date): string {
    // Try DD Mon YYYY (e.g., "10 Mar 2026")
    const monthNames: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const namedMatch = text.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{4})/i);
    if (namedMatch) {
      const day = namedMatch[1]!.padStart(2, '0');
      const month = monthNames[namedMatch[2]!.toLowerCase().slice(0, 3)]!;
      return `${namedMatch[3]}-${month}-${day}`;
    }

    const numMatch = text.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
    if (numMatch) {
      const day = numMatch[1]!.padStart(2, '0');
      const month = numMatch[2]!.padStart(2, '0');
      const year = numMatch[3] ? (numMatch[3].length === 2 ? `20${numMatch[3]}` : numMatch[3]) : String(fetchedAt.getFullYear());
      return `${year}-${month}-${day}`;
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
