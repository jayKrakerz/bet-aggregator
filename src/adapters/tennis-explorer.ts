import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * TennisExplorer adapter (tennisexplorer.com).
 *
 * STATUS: URL returns 404 via Varnish cache. The prediction path
 * no longer exists on tennisexplorer.com. Check for updated URL.
 *
 * Static HTML site with match predictions and probability percentages.
 *
 * Expected page structure:
 *   - Prediction table: `table.result` or `table.predict`
 *   - Each row: `tr` with cells for date, player1, player2, probability percentages
 *   - Player names: `td.t-name a` or `td a[href*="/player/"]`
 *   - Win probabilities: `td.per` cells showing "65%" / "35%"
 *   - Date headers: `thead tr` or `.date-header` grouping matches by date
 *   - Tournament info: `th` or `.tour` cells with tournament name
 */
export class TennisExplorerAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'tennis-explorer',
    name: 'Tennis Explorer',
    baseUrl: 'https://www.tennisexplorer.com',
    fetchMethod: 'http',
    paths: {
      tennis: '/predictions/',
    },
    cron: '0 0 5,11,17 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentDate = fetchedAt.toISOString().split('T')[0]!;
    let currentTournament = '';

    $('table.result tr, table.predict tr, table.table-main tr').each((_i, el) => {
      const $row = $(el);

      // Date header rows
      const dateHeader = $row.find('th.date, th.first, .date-header').text().trim();
      if (dateHeader) {
        const parsed = this.parseDateHeader(dateHeader, fetchedAt);
        if (parsed) currentDate = parsed;
        return;
      }

      // Tournament header rows
      const tourText = $row.find('th.tour, th.tournament, td.tour').text().trim();
      if (tourText && !$row.find('td.t-name, td.player').length) {
        currentTournament = tourText;
        return;
      }

      // Match rows with player names
      const playerCells = $row.find('td.t-name a, td.player a, td a[href*="/player/"]');
      if (playerCells.length < 2) return;

      const player1 = $(playerCells[0]).text().trim();
      const player2 = $(playerCells[1]).text().trim();
      if (!player1 || !player2) return;

      // Extract win probabilities from percentage cells
      const probCells = $row.find('td.per, td.percentage, td.prob');
      let p1Prob = 0;
      let p2Prob = 0;
      if (probCells.length >= 2) {
        p1Prob = parseInt($(probCells[0]).text().replace('%', '').trim(), 10) || 0;
        p2Prob = parseInt($(probCells[1]).text().replace('%', '').trim(), 10) || 0;
      }

      // Determine predicted winner based on higher probability
      const side: Side = p1Prob >= p2Prob ? 'home' : 'away';
      const winProb = Math.max(p1Prob, p2Prob);
      const confidence = this.probToConfidence(winProb);

      // Extract time if available
      const timeCell = $row.find('td.time, td.first').first().text().trim();
      const timeMatch = timeCell.match(/(\d{1,2}:\d{2})/);
      const gameTime = timeMatch ? timeMatch[1]! : null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate: currentDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'Tennis Explorer',
        confidence,
        reasoning: currentTournament
          ? `${currentTournament} | Win prob: ${p1Prob}%-${p2Prob}%`
          : (winProb > 0 ? `Win prob: ${p1Prob}%-${p2Prob}%` : null),
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseDateHeader(text: string, fetchedAt: Date): string | null {
    // Formats: "Monday, 10 Mar 2026", "10.03.2026", "2026-03-10"
    const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

    const euroMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (euroMatch) {
      return `${euroMatch[3]}-${euroMatch[2]!.padStart(2, '0')}-${euroMatch[1]!.padStart(2, '0')}`;
    }

    const longMatch = text.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s*(\d{4})?/i);
    if (longMatch) {
      const months: Record<string, string> = {
        jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
        jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
      };
      const day = longMatch[1]!.padStart(2, '0');
      const month = months[longMatch[2]!.toLowerCase().slice(0, 3)] || '01';
      const year = longMatch[3] || fetchedAt.getFullYear().toString();
      return `${year}-${month}-${day}`;
    }

    return null;
  }

  private probToConfidence(prob: number): RawPrediction['confidence'] {
    if (prob >= 80) return 'best_bet';
    if (prob >= 65) return 'high';
    if (prob >= 50) return 'medium';
    if (prob > 0) return 'low';
    return null;
  }
}
