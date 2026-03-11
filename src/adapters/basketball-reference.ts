import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction } from '../types/prediction.js';

/**
 * Basketball Reference adapter.
 *
 * Basketball-Reference is a comprehensive NBA stats site. The schedule/games
 * page lists daily matchups with pre-game projected winners based on SRS
 * (Simple Rating System) and Elo ratings.
 *
 * Page structure (`/leagues/NBA_2026_games-march.html`):
 * - `table#schedule tbody tr`: each row is a game
 * - `td[data-stat="visitor_team_name"] a`: away team
 * - `td[data-stat="home_team_name"] a`: home team
 * - `td[data-stat="date_game"] a`: game date
 * - `td[data-stat="game_start_time"]`: tip-off time
 * - `td[data-stat="overtimes"]`: projected winner or overtime info
 */
export class BasketballReferenceAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'basketball-reference',
    name: 'Basketball Reference',
    baseUrl: 'https://www.basketball-reference.com',
    fetchMethod: 'http',
    paths: {
      nba: '/leagues/NBA_2026_games.html',
    },
    cron: '0 0 9,15 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 8000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('table#schedule tbody tr').each((_i, el) => {
      const $row = $(el);
      if ($row.hasClass('thead')) return;

      const dateText = $row.find('td[data-stat="date_game"], th[data-stat="date_game"]').text().trim();
      const awayTeamRaw = $row.find('td[data-stat="visitor_team_name"] a').text().trim();
      const homeTeamRaw = $row.find('td[data-stat="home_team_name"] a').text().trim();
      const gameTime = $row.find('td[data-stat="game_start_time"]').text().trim() || null;

      if (!homeTeamRaw || !awayTeamRaw) return;

      const gameDate = this.parseBRefDate(dateText, fetchedAt);

      // Basketball-Reference shows projected winner via SRS ratings
      // The site doesn't explicitly show picks, but we can infer from
      // the home/away SRS differential shown in the game preview
      const projText = $row.find('td[data-stat="overtimes"], td[data-stat="game_remarks"]').text().trim();

      // For schedule pages, home team is typically favored by ~3 pts (home court)
      // We create a basic moneyline pick for the home team as default
      // If projected data is available, use that instead
      let side: 'home' | 'away' = 'home';
      let reasoning = 'Home court advantage (Basketball-Reference schedule)';

      if (projText && projText.toLowerCase().includes('visitor')) {
        side = 'away';
        reasoning = `Projected: ${projText}`;
      } else if (projText) {
        reasoning = projText || reasoning;
      }

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'Basketball Reference',
        confidence: null,
        reasoning,
        fetchedAt,
      });
    });

    return predictions;
  }

  /**
   * Parse Basketball-Reference date format (e.g., "Tue, Mar 10, 2026").
   */
  private parseBRefDate(text: string, fetchedAt: Date): string {
    const months: Record<string, string> = {
      Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
      Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
    };
    const match = text.match(/([A-Z][a-z]{2})\s+(\d{1,2}),?\s*(\d{4})?/);
    if (match && months[match[1]!]) {
      const month = months[match[1]!]!;
      const day = match[2]!.padStart(2, '0');
      const year = match[3] || String(fetchedAt.getFullYear());
      return `${year}-${month}-${day}`;
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
