import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * SoccerVista adapter.
 *
 * STATUS: UNFIXABLE - /soccer-predictions/ returns a clean 404 page as of
 * 2026-03-10. The 404 page is a simple Tailwind CSS layout with "Page Not
 * Found" message and links to homepage/go-back. The site appears to have
 * removed or restructured its predictions. This adapter cannot produce
 * predictions until a valid URL is found.
 */
export class SoccervistaAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'soccervista',
    name: 'SoccerVista',
    baseUrl: 'https://www.soccervista.com',
    fetchMethod: 'http',
    paths: {
      football: '/soccer-predictions/',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentLeague = '';

    // Detect 404 / error pages early
    const title = $('title').text().toLowerCase();
    if (title.includes('not found') || title.includes('404')) {
      return predictions;
    }

    $('table.main-table tr, #predictions-table tr, table.predictions tr').each((_i, el) => {
      const $row = $(el);

      // League header rows
      if ($row.hasClass('league-header') || $row.hasClass('leaguerow')) {
        currentLeague = $row.text().trim();
        return;
      }

      const cells = $row.find('td');
      if (cells.length < 6) return;

      // Try to parse teams from typical column positions
      const col0 = $(cells[0]).text().trim();
      const col1 = $(cells[1]).text().trim();
      const col2 = $(cells[2]).text().trim();
      const col3 = $(cells[3]).text().trim();

      // Detect layout: first check if col0 is a date
      let homeTeam: string, awayTeam: string, dateText: string, timeText: string;
      const isDate = /\d{1,2}[.\/-]\d{1,2}/.test(col0);

      if (isDate) {
        dateText = col0;
        timeText = col1;
        homeTeam = col2;
        awayTeam = col3;
      } else {
        // col0 might be league, col1 date, etc.
        currentLeague = col0 || currentLeague;
        dateText = col1;
        timeText = '';
        homeTeam = col2;
        awayTeam = col3;
      }

      if (!homeTeam || !awayTeam) return;

      // Extract probabilities from last few numeric columns
      const probs: number[] = [];
      cells.each((_j, cell) => {
        const text = $(cell).text().trim().replace('%', '');
        const num = parseInt(text, 10);
        if (!isNaN(num) && num >= 0 && num <= 100 && text.length <= 3) {
          probs.push(num);
        }
      });

      // Extract prediction tip
      const tipCell = $row.find('.prediction, .tip, .pick, td.highlight, td strong, td b');
      let tip = tipCell.text().trim();
      if (!tip) {
        // Try last text column
        tip = $(cells[cells.length - 1]).text().trim();
      }

      const side = this.mapTipToSide(tip);
      if (!side) return;

      const confidence = this.probsToConfidence(probs, side);
      const gameDate = this.extractDate(dateText, fetchedAt);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate,
        gameTime: timeText || null,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'SoccerVista',
        confidence,
        reasoning: [
          currentLeague,
          probs.length >= 3 ? `Prob: ${probs[0]}/${probs[1]}/${probs[2]}` : '',
        ].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private mapTipToSide(tip: string): Side | null {
    const t = tip.toUpperCase().trim();
    if (t === '1' || t === 'HOME') return 'home';
    if (t === '2' || t === 'AWAY') return 'away';
    if (t === 'X' || t === 'DRAW') return 'draw';
    if (t === '1X') return 'home';
    if (t === 'X2') return 'away';
    return null;
  }

  private probsToConfidence(probs: number[], side: Side): Confidence | null {
    if (probs.length < 3) return null;
    let prob: number;
    if (side === 'home') prob = probs[0]!;
    else if (side === 'draw') prob = probs[1]!;
    else prob = probs[2]!;

    if (prob >= 70) return 'best_bet';
    if (prob >= 55) return 'high';
    if (prob >= 40) return 'medium';
    return 'low';
  }

  private extractDate(text: string, fetchedAt: Date): string {
    const match = text.match(/(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?/);
    if (match) {
      const day = match[1]!.padStart(2, '0');
      const month = match[2]!.padStart(2, '0');
      const year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : String(fetchedAt.getFullYear());
      return `${year}-${month}-${day}`;
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
