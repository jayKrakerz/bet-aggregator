import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * TennisStats247 adapter (tennisstats247.com).
 *
 * STATUS: Site is behind Cloudflare challenge. Changed to browser
 * fetch to attempt bypassing the JS challenge.
 *
 * Static HTML site with detailed tennis statistics and match predictions.
 * Predictions are typically displayed in a table with probabilities.
 *
 * Expected page structure:
 *   - Prediction table: `table.predictions`, `table.matches`, `.prediction-table`
 *   - Header rows: `thead tr` with column names (Date, Player1, Player2, Prob, Prediction)
 *   - Match rows: `tbody tr` with cells for each column
 *   - Player links: `td a[href*="/player/"]`
 *   - Probabilities: `td.prob`, `td.percentage` with win % for each player
 *   - Prediction: `td.prediction`, `td.tip` with predicted winner name
 *   - Date: `td.date` or first cell in row
 *   - Tournament groups: `tr.tournament-header`, `th[colspan]` with tournament name
 *   - Confidence: derived from probability spread
 */
export class TennisStats247Adapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'tennisstats247',
    name: 'TennisStats247',
    baseUrl: 'https://www.tennisstats247.com',
    fetchMethod: 'browser',
    paths: {
      tennis: '/predictions/',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentTournament = '';
    let currentDate = fetchedAt.toISOString().split('T')[0]!;

    // Parse prediction tables
    $('table.predictions tbody tr, table.matches tbody tr, .prediction-table tbody tr, table tr').each((_i, el) => {
      const $row = $(el);
      const cells = $row.find('td');

      // Skip rows with too few cells
      if (cells.length < 3) {
        // Check if it's a tournament header
        const th = $row.find('th[colspan], th.tournament');
        if (th.length) {
          currentTournament = th.text().trim();
        }
        // Check if it's a tournament header in a td
        if ($row.hasClass('tournament-header') || $row.hasClass('group-header')) {
          currentTournament = $row.text().trim();
        }
        return;
      }

      // Extract player names from links or text cells
      const playerLinks = $row.find('a[href*="/player/"], td.player a, td.name a');
      let player1 = '';
      let player2 = '';

      if (playerLinks.length >= 2) {
        player1 = $(playerLinks[0]).text().trim();
        player2 = $(playerLinks[1]).text().trim();
      } else {
        // Try text cells containing player names
        const textCells: string[] = [];
        cells.each((_j, cell) => {
          const text = $(cell).text().trim();
          // Skip cells that look like dates, numbers, or percentages
          if (text && !/^\d{1,2}[./-]/.test(text) && !/^\d+%?$/.test(text) && text.length > 2) {
            textCells.push(text);
          }
        });
        if (textCells.length >= 2) {
          player1 = textCells[0]!;
          player2 = textCells[1]!;
        } else if (textCells.length === 1) {
          // "Player1 vs Player2" in a single cell
          const vsMatch = textCells[0]!.match(/(.+?)\s+(?:vs?\.?|[-])\s+(.+)/i);
          if (vsMatch) {
            player1 = vsMatch[1]!.trim();
            player2 = vsMatch[2]!.trim();
          }
        }
      }

      if (!player1 || !player2) return;

      // Extract probabilities
      const probCells = $row.find('td.prob, td.percentage, td.win-prob');
      let p1Prob = 0;
      let p2Prob = 0;
      if (probCells.length >= 2) {
        p1Prob = parseInt($(probCells[0]).text().replace('%', '').trim(), 10) || 0;
        p2Prob = parseInt($(probCells[1]).text().replace('%', '').trim(), 10) || 0;
      } else {
        // Look for percentage values in any cells
        cells.each((_j, cell) => {
          const text = $(cell).text().trim();
          const pctMatch = text.match(/^(\d{1,3})%$/);
          if (pctMatch) {
            const val = parseInt(pctMatch[1]!, 10);
            if (p1Prob === 0) p1Prob = val;
            else if (p2Prob === 0) p2Prob = val;
          }
        });
      }

      // Extract prediction cell
      const predCell = $row.find('td.prediction, td.tip, td.pick').first().text().trim();

      // Determine side
      let side: Side = 'home';
      if (predCell) {
        side = this.resolveSide(predCell, player1, player2);
      } else if (p1Prob > 0 || p2Prob > 0) {
        side = p1Prob >= p2Prob ? 'home' : 'away';
      }

      const maxProb = Math.max(p1Prob, p2Prob);

      // Extract date
      const dateCell = cells.first().text().trim();
      const dateMatch = dateCell.match(/(\d{1,2})[./](\d{1,2})[./]?(\d{2,4})?/);
      if (dateMatch) {
        const day = dateMatch[1]!.padStart(2, '0');
        const month = dateMatch[2]!.padStart(2, '0');
        const year = dateMatch[3]
          ? (dateMatch[3].length === 2 ? `20${dateMatch[3]}` : dateMatch[3])
          : fetchedAt.getFullYear().toString();
        currentDate = `${year}-${month}-${day}`;
      }

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate: currentDate,
        gameTime: null,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'TennisStats247',
        confidence: this.probToConfidence(maxProb),
        reasoning: [
          currentTournament,
          maxProb > 0 ? `Win prob: ${p1Prob}%-${p2Prob}%` : '',
        ].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private resolveSide(text: string, player1: string, player2: string): Side {
    const lower = text.toLowerCase();
    const p1Last = player1.toLowerCase().split(' ').pop() || '';
    const p2Last = player2.toLowerCase().split(' ').pop() || '';

    if (p1Last.length > 2 && lower.includes(p1Last)) return 'home';
    if (p2Last.length > 2 && lower.includes(p2Last)) return 'away';
    // "1" = player1, "2" = player2
    if (lower.trim() === '1') return 'home';
    if (lower.trim() === '2') return 'away';
    return 'home';
  }

  private probToConfidence(prob: number): RawPrediction['confidence'] {
    if (prob >= 80) return 'best_bet';
    if (prob >= 65) return 'high';
    if (prob >= 50) return 'medium';
    if (prob > 0) return 'low';
    return null;
  }
}
