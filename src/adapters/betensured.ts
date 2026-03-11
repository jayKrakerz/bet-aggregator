import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Betensured adapter.
 *
 * Betensured.com shows football predictions with percentage-based confidence.
 *
 * Expected page structure:
 * - Prediction cards/rows in `.prediction-card` or `.match-row`
 * - Each card contains:
 *   - `.home-team` and `.away-team` with team names
 *   - `.match-date` or `.date` with date info
 *   - `.prediction` or `.tip` with 1/X/2 pick
 *   - `.percentage` or `.confidence` with win probability percentage
 *   - `.league` with competition name
 *   - `.match-time` with kickoff time
 *
 * Alternative table layout:
 * - `table.predictions-table tbody tr`
 * - Columns: Date | Time | League | Home | Away | Tip | Confidence%
 */
export class BetensuredAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'betensured',
    name: 'Betensured',
    baseUrl: 'https://www.betensured.com',
    fetchMethod: 'http',
    paths: {
      football: '/predictions',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Try card-based layout first
    $('.prediction-card, .match-row, .prediction-row').each((_i, el) => {
      const $el = $(el);

      const homeTeam = $el.find('.home-team, .home, .team-home').text().trim();
      const awayTeam = $el.find('.away-team, .away, .team-away').text().trim();
      if (!homeTeam || !awayTeam) return;

      const tip = $el.find('.prediction, .tip, .pick').text().trim();
      const side = this.mapTipToSide(tip);
      if (!side) return;

      const pctText = $el.find('.percentage, .confidence, .prob').text().trim();
      const pct = parseInt(pctText.replace('%', ''), 10);
      const confidence = this.pctToConfidence(pct);

      const dateText = $el.find('.match-date, .date').text().trim();
      const gameDate = this.extractDate(dateText, fetchedAt);
      const gameTime = $el.find('.match-time, .time, .kickoff').text().trim() || null;
      const league = $el.find('.league, .competition').text().trim();

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'Betensured',
        confidence,
        reasoning: [league, !isNaN(pct) ? `Confidence: ${pct}%` : ''].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    // Fallback: table-based layout
    if (predictions.length === 0) {
      $('table.predictions-table tbody tr, table.table tbody tr').each((_i, el) => {
        const cells = $(el).find('td');
        if (cells.length < 5) return;

        const dateText = $(cells[0]).text().trim();
        const timeText = $(cells[1]).text().trim();
        const homeTeam = $(cells[2]).text().trim() || $(cells[3]).text().trim();
        const awayTeam = $(cells[3]).text().trim() || $(cells[4]).text().trim();
        if (!homeTeam || !awayTeam || homeTeam === awayTeam) return;

        const tip = $(cells[cells.length - 2]).text().trim();
        const side = this.mapTipToSide(tip);
        if (!side) return;

        const pctText = $(cells[cells.length - 1]).text().trim();
        const pct = parseInt(pctText.replace('%', ''), 10);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate: this.extractDate(dateText, fetchedAt),
          gameTime: timeText || null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'Betensured',
          confidence: this.pctToConfidence(pct),
          reasoning: !isNaN(pct) ? `Confidence: ${pct}%` : null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private mapTipToSide(tip: string): Side | null {
    const t = tip.toUpperCase().trim();
    if (t === '1' || t === 'HOME' || t === 'H') return 'home';
    if (t === '2' || t === 'AWAY' || t === 'A') return 'away';
    if (t === 'X' || t === 'DRAW' || t === 'D') return 'draw';
    if (t === '1X') return 'home';
    if (t === 'X2' || t === '2X') return 'away';
    return null;
  }

  private pctToConfidence(pct: number): Confidence | null {
    if (isNaN(pct)) return null;
    if (pct >= 75) return 'best_bet';
    if (pct >= 60) return 'high';
    if (pct >= 45) return 'medium';
    return 'low';
  }

  private extractDate(text: string, fetchedAt: Date): string {
    // Try DD/MM/YYYY or DD-MM-YYYY
    const match = text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (match) {
      const day = match[1]!.padStart(2, '0');
      const month = match[2]!.padStart(2, '0');
      const year = match[3]!.length === 2 ? `20${match[3]}` : match[3]!;
      return `${year}-${month}-${day}`;
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
