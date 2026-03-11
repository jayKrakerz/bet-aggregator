import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * SoccerTipz adapter.
 *
 * Scrapes daily soccer predictions from soccertipz.com.
 * The site uses WordPress + Elementor. Predictions are at /soccer-predictions-today/.
 * Layout is Elementor widgets rendering a grid of matches with:
 *   - League headers (flag + league name)
 *   - Match rows: home team vs away team
 *   - 1X2 prediction (green W = predicted winner, orange D = draw predicted)
 *   - Odds columns: 1, X, 2
 *
 * Elementor renders predictions as styled divs/tables inside
 * .elementor-widget containers. Also supports wp-block-table fallback.
 */
export class SoccertipzAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'soccertipz',
    name: 'SoccerTipz',
    baseUrl: 'https://soccertipz.com',
    fetchMethod: 'http',
    paths: {
      football: '/soccer-predictions-today/',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Strategy 1: wp-block-table or standard HTML tables
    // Soccertipz often renders predictions inside <figure class="wp-block-table"> > <table>
    $('figure.wp-block-table table, table.wp-block-table, table').each((_i, tableEl) => {
      const $table = $(tableEl);
      let currentLeague = '';

      $table.find('tr').each((_j, rowEl) => {
        const $row = $(rowEl);

        // Skip header rows
        if ($row.find('th').length > 0) {
          // Could be a league header in th
          const headerText = $row.text().trim();
          if (headerText && !headerText.match(/^(1|X|2|Home|Away|Draw|Odds|Tip|Prediction)/i)) {
            currentLeague = headerText;
          }
          return;
        }

        const cells = $row.find('td');
        if (cells.length < 3) return;

        // Look for "Team vs Team" pattern in any cell
        let homeTeam = '';
        let awayTeam = '';
        let tipText = '';
        let odds1 = '';
        let oddsX = '';
        let odds2 = '';

        for (let c = 0; c < cells.length; c++) {
          const cellText = $(cells[c]).text().trim();
          const vsMatch = cellText.match(/^(.+?)\s+(?:vs\.?|v\.?)\s+(.+)$/i);
          if (vsMatch && vsMatch[1] && vsMatch[2]) {
            homeTeam = vsMatch[1].trim();
            awayTeam = vsMatch[2].trim();
            // Remaining cells should be tip and odds
            if (c + 1 < cells.length) tipText = $(cells[c + 1]).text().trim();
            if (c + 2 < cells.length) odds1 = $(cells[c + 2]).text().trim();
            if (c + 3 < cells.length) oddsX = $(cells[c + 3]).text().trim();
            if (c + 4 < cells.length) odds2 = $(cells[c + 4]).text().trim();
            break;
          }
        }

        // Fallback: first cell has teams separated by " - " or newlines
        if (!homeTeam || !awayTeam) {
          const firstCell = $(cells[0]).text().trim();
          const dashMatch = firstCell.match(/^(.+?)\s+[-–]\s+(.+)$/);
          if (dashMatch && dashMatch[1] && dashMatch[2]) {
            homeTeam = dashMatch[1].trim();
            awayTeam = dashMatch[2].trim();
          }
        }

        // Positional fallback: home | away | tip | odds columns
        if (!homeTeam || !awayTeam) {
          if (cells.length >= 5) {
            homeTeam = $(cells[0]).text().trim();
            awayTeam = $(cells[1]).text().trim();
            tipText = $(cells[2]).text().trim();
            odds1 = $(cells[3]).text().trim();
            odds2 = $(cells[4]).text().trim();
          } else if (cells.length >= 4) {
            homeTeam = $(cells[0]).text().trim();
            awayTeam = $(cells[1]).text().trim();
            tipText = $(cells[2]).text().trim();
            odds1 = $(cells[3]).text().trim();
          }
        }

        if (!homeTeam || !awayTeam) return;

        // Detect prediction from W/D/L indicators or tip text
        let side: Side | null = null;

        if (tipText) {
          side = this.mapTipToSide(tipText);
        }

        // If no explicit tip, try to infer from green/bold styling on odds cells
        if (!side) {
          // Check for W indicator or bold/highlighted cell
          for (let c = 0; c < cells.length; c++) {
            const $cell = $(cells[c]);
            const text = $cell.text().trim().toUpperCase();
            if (text === 'W' || text === '1') {
              side = 'home';
              break;
            }
            if (text === 'D' || text === 'X') {
              side = 'draw';
              break;
            }
            if (text === 'L' || text === '2') {
              side = 'away';
              break;
            }
          }
        }

        if (!side) side = 'home'; // Default

        const oddsValue = this.parseOdds(odds1 || oddsX || odds2);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate: today,
          gameTime: null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'SoccerTipz',
          confidence: this.oddsToConfidence(oddsValue),
          reasoning: currentLeague || null,
          fetchedAt,
        });
      });
    });

    if (predictions.length > 0) return predictions;

    // Strategy 2: Elementor widget layout - parse text blocks
    // Elementor renders matches as text within .elementor-widget-text-editor
    let currentLeague = '';
    const textBlocks: string[] = [];

    $('.elementor-widget-text-editor .elementor-widget-container, .elementor-text-editor').each((_i, el) => {
      const text = $(el).text().trim();
      if (text) textBlocks.push(text);
    });

    // Also try elementor headings as league headers
    $('.elementor-heading-title').each((_i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 3 && !text.match(/^\d/)) {
        currentLeague = text;
      }
    });

    // Parse text blocks looking for "Team vs Team" patterns
    for (const block of textBlocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const vsMatch = line.match(/^(.+?)\s+(?:vs\.?|v\.?|-)\s+(.+?)(?:\s+(\d+[.]\d+)\s+(\d+[.]\d+)\s+(\d+[.]\d+))?$/i);
        if (vsMatch && vsMatch[1] && vsMatch[2]) {
          const homeTeam = vsMatch[1].trim();
          const awayTeam = vsMatch[2].trim();

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: homeTeam,
            awayTeamRaw: awayTeam,
            gameDate: today,
            gameTime: null,
            pickType: 'moneyline',
            side: 'home',
            value: null,
            pickerName: 'SoccerTipz',
            confidence: null,
            reasoning: currentLeague || null,
            fetchedAt,
          });
        }
      }
    }

    return predictions;
  }

  private mapTipToSide(tip: string): Side | null {
    const t = tip.toUpperCase().trim();
    if (t === '1' || t === 'H' || t === 'HOME' || t === 'W' || t === '1X') return 'home';
    if (t === '2' || t === 'A' || t === 'AWAY' || t === 'X2') return 'away';
    if (t === 'X' || t === 'D' || t === 'DRAW') return 'draw';
    if (t.startsWith('OVER') || t === 'OV') return 'over';
    if (t.startsWith('UNDER') || t === 'UN') return 'under';
    if (t === 'GG' || t === 'BTTS YES' || t === 'YES') return 'yes';
    if (t === 'NG' || t === 'BTTS NO' || t === 'NO') return 'no';
    return null;
  }

  private parseOdds(text: string): number | null {
    if (!text) return null;
    const num = parseFloat(text.replace(/[^0-9.]/g, ''));
    return isNaN(num) ? null : num;
  }

  private oddsToConfidence(odds: number | null): Confidence | null {
    if (odds === null || isNaN(odds) || odds <= 0) return null;
    const impliedProb = 1 / odds;
    if (impliedProb >= 0.75) return 'best_bet';
    if (impliedProb >= 0.55) return 'high';
    if (impliedProb >= 0.35) return 'medium';
    return 'low';
  }
}
