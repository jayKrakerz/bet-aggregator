import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * FootSuper adapter.
 *
 * Footsuper.com provides football predictions organized by league.
 *
 * Expected page structure:
 * - League sections with `.league-section` or `h2/h3` league headers
 * - Prediction table rows under each league
 * - Each row: Date | Time | Home | Away | Prediction | Score | Probability
 * - Prediction column uses 1/X/2 format
 * - Probability shown as percentage or star rating
 *
 * Alternative layout:
 * - `.match-prediction` cards with `.home`, `.away`, `.tip`, `.prob` elements
 */
export class FootsuperAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'footsuper',
    name: 'FootSuper',
    baseUrl: 'https://www.footsuper.com',
    fetchMethod: 'http',
    paths: {
      football: '/predictions/',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentLeague = '';

    // Table-based layout
    $('table tr, .prediction-table tr').each((_i, el) => {
      const $row = $(el);

      // League header rows
      if ($row.find('th').length > 0 || $row.hasClass('league-header')) {
        const headerText = $row.text().trim();
        if (headerText && !headerText.includes('Home') && !headerText.includes('Date')) {
          currentLeague = headerText;
        }
        return;
      }

      const cells = $row.find('td');
      if (cells.length < 5) return;

      const dateText = $(cells[0]).text().trim();
      const timeText = $(cells[1]).text().trim();
      const homeTeam = $(cells[2]).text().trim();
      const awayTeam = $(cells[3]).text().trim();
      if (!homeTeam || !awayTeam) return;

      const tip = $(cells[4]).text().trim();
      const side = this.mapTipToSide(tip);
      if (!side) return;

      const probText = cells.length > 5 ? $(cells[5]).text().trim() : '';
      const prob = parseInt(probText.replace('%', ''), 10);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate: this.extractDate(dateText, fetchedAt),
        gameTime: /\d{1,2}:\d{2}/.test(timeText) ? timeText : null,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'FootSuper',
        confidence: this.pctToConfidence(prob),
        reasoning: [currentLeague, !isNaN(prob) ? `Probability: ${prob}%` : ''].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    // Fallback: card layout
    if (predictions.length === 0) {
      $('.match-prediction, .prediction-card').each((_i, el) => {
        const $el = $(el);
        const homeTeam = $el.find('.home, .home-team').text().trim();
        const awayTeam = $el.find('.away, .away-team').text().trim();
        if (!homeTeam || !awayTeam) return;

        const tip = $el.find('.tip, .prediction, .pick').text().trim();
        const side = this.mapTipToSide(tip);
        if (!side) return;

        const probText = $el.find('.prob, .probability, .pct').text().trim();
        const prob = parseInt(probText.replace('%', ''), 10);
        const dateText = $el.find('.date, .match-date').text().trim();

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate: this.extractDate(dateText, fetchedAt),
          gameTime: null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'FootSuper',
          confidence: this.pctToConfidence(prob),
          reasoning: !isNaN(prob) ? `Probability: ${prob}%` : null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private mapTipToSide(tip: string): Side | null {
    const t = tip.toUpperCase().trim();
    if (t === '1' || t === 'HOME' || t === 'W1') return 'home';
    if (t === '2' || t === 'AWAY' || t === 'W2') return 'away';
    if (t === 'X' || t === 'DRAW' || t === 'D') return 'draw';
    if (t === '1X') return 'home';
    if (t === 'X2') return 'away';
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
    const match = text.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
    if (match) {
      const day = match[1]!.padStart(2, '0');
      const month = match[2]!.padStart(2, '0');
      const year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : String(fetchedAt.getFullYear());
      return `${year}-${month}-${day}`;
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
