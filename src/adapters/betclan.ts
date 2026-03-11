import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * BetClan adapter.
 *
 * STATUS: BROKEN - /football-predictions/ returns 404 as of 2026-03-10.
 * The site may have restructured or removed this page. Needs URL discovery.
 *
 * Betclan.com provides football predictions with statistical analysis.
 *
 * Expected page structure:
 * - Predictions in a table: `table.prediction-table` or `table.table`
 * - League headers as `tr.league-row` or separate `h3`/`h4` elements
 * - Match rows with columns:
 *   - Date/Time | League | Home Team | Score | Away Team | Tip | Prob% | Result
 * - Tips use standard 1/X/2 format
 * - Probabilities shown as percentages
 *
 * Alternative card layout:
 * - `.match-block` containers with `.teams`, `.prediction`, `.stats` sub-elements
 * - Stats section may include form, h2h, and league position data
 */
export class BetclanAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'betclan',
    name: 'BetClan',
    baseUrl: 'https://www.betclan.com',
    fetchMethod: 'http',
    paths: {
      football: '/football-predictions/',
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

    // Table layout
    $('table.prediction-table tr, table.table tr, table tbody tr').each((_i, el) => {
      const $row = $(el);

      // League header
      if ($row.hasClass('league-row') || $row.hasClass('league-header')) {
        currentLeague = $row.text().trim();
        return;
      }

      const cells = $row.find('td');
      if (cells.length < 5) return;

      // Detect columns dynamically
      const texts = cells.map((_j, cell) => $(cell).text().trim()).get();

      // Find team columns: look for cells that aren't dates, numbers, or short codes
      const teamIndices = this.findTeamColumns(texts);
      if (!teamIndices) return;

      const homeTeam = texts[teamIndices.home]!;
      const awayTeam = texts[teamIndices.away]!;

      // Find tip: look for 1/X/2 pattern
      let tip = '';
      let prob = NaN;
      for (const text of texts) {
        const side = this.mapTipToSide(text);
        if (side) { tip = text; break; }
      }
      if (!tip) return;

      const side = this.mapTipToSide(tip)!;

      // Find probability percentage
      for (const text of texts) {
        const num = parseInt(text.replace('%', ''), 10);
        if (!isNaN(num) && num >= 20 && num <= 100) {
          prob = num;
          break;
        }
      }

      // Find date
      let dateText = '';
      for (const text of texts) {
        if (/\d{1,2}[\/\-.](\d{1,2})/.test(text)) {
          dateText = text;
          break;
        }
      }

      const league = $(cells[0]).find('img').attr('alt') || currentLeague;

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
        pickerName: 'BetClan',
        confidence: this.pctToConfidence(prob),
        reasoning: [league, !isNaN(prob) ? `Probability: ${prob}%` : ''].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    // Fallback: card layout
    if (predictions.length === 0) {
      $('.match-block, .prediction-card').each((_i, el) => {
        const $el = $(el);
        const matchText = $el.find('.teams, .match-title').text().trim();
        const teams = this.parseTeams(matchText);
        if (!teams) return;

        const tip = $el.find('.prediction, .tip, .pick').text().trim();
        const side = this.mapTipToSide(tip);
        if (!side) return;

        const probText = $el.find('.probability, .prob, .pct').text().trim();
        const prob = parseInt(probText.replace('%', ''), 10);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: teams.home,
          awayTeamRaw: teams.away,
          gameDate: fetchedAt.toISOString().split('T')[0]!,
          gameTime: null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'BetClan',
          confidence: this.pctToConfidence(prob),
          reasoning: !isNaN(prob) ? `Probability: ${prob}%` : null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private findTeamColumns(texts: string[]): { home: number; away: number } | null {
    // Look for two adjacent cells that look like team names (not dates, numbers, or single chars)
    const candidates: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i]!;
      if (
        t.length > 2 &&
        !/^\d+[%]?$/.test(t) &&
        !/^\d{1,2}[\/\-.]/.test(t) &&
        !['1', '2', 'X', '1X', 'X2'].includes(t.toUpperCase())
      ) {
        candidates.push(i);
      }
    }
    if (candidates.length >= 2) {
      return { home: candidates[0]!, away: candidates[1]! };
    }
    return null;
  }

  private parseTeams(text: string): { home: string; away: string } | null {
    let parts = text.split(/\s+vs\.?\s+/i);
    if (parts.length < 2) parts = text.split(/\s+-\s+/);
    if (parts.length < 2) return null;
    const home = parts[0]!.trim();
    const away = parts.slice(1).join('-').trim();
    return home && away ? { home, away } : null;
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
    if (pct >= 70) return 'best_bet';
    if (pct >= 55) return 'high';
    if (pct >= 40) return 'medium';
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
