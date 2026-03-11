import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Baseball Reference adapter.
 *
 * STATUS: NO DATA IN SNAPSHOT - /previews/ loads the "Probable Pitchers" page
 * but the snapshot from 2026-03-10 (spring training) contains zero .game_summary
 * blocks. The page only shows game_summary blocks during the regular season
 * (starts ~March 25, 2026). Selectors cannot be validated until then.
 * The existing .game_summary selectors match the known regular-season DOM.
 *
 * Scrapes MLB game previews and projections from baseball-reference.com.
 * The schedule/projections page lists upcoming games in a table format:
 *
 * - `.game_summary` blocks contain matchup info
 * - Each block has `.teams` table with home/away rows
 * - Win probability shown in `.prob` cells
 * - Game date in `.section_heading` or parsed from page URL
 * - Starting pitchers listed in `.pitcher` cells
 */
export class BaseballReferenceAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'baseball-reference',
    name: 'Baseball Reference',
    baseUrl: 'https://www.baseball-reference.com',
    fetchMethod: 'http',
    paths: {
      mlb: '/previews/',
    },
    cron: '0 0 8,12,16 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    $('.game_summary').each((_i, el) => {
      const $game = $(el);
      const rows = $game.find('.teams tr');

      let awayTeamRaw = '';
      let homeTeamRaw = '';
      let awayProb = 0;
      let homeProb = 0;
      let gameTime: string | null = null;

      rows.each((_j, row) => {
        const $row = $(row);
        const teamName = $row.find('td a').first().text().trim();
        const probText = $row.find('.prob').text().trim().replace('%', '');
        const prob = parseInt(probText, 10);

        if (!teamName) return;

        // First team row is away, second is home
        if (!awayTeamRaw) {
          awayTeamRaw = teamName;
          awayProb = isNaN(prob) ? 0 : prob;
        } else if (!homeTeamRaw) {
          homeTeamRaw = teamName;
          homeProb = isNaN(prob) ? 0 : prob;
        }
      });

      if (!homeTeamRaw || !awayTeamRaw) return;

      // Extract game time from the summary
      const timeText = $game.find('.time').text().trim();
      if (timeText) gameTime = timeText;

      // Determine pick side based on win probability
      const side: Side = homeProb >= awayProb ? 'home' : 'away';
      const winProb = Math.max(homeProb, awayProb);

      const confidence = winProb >= 65 ? 'high' as const
        : winProb >= 55 ? 'medium' as const
        : 'low' as const;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate: today,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'Baseball Reference',
        confidence,
        reasoning: `Win probability: ${side === 'home' ? homeProb : awayProb}%`,
        fetchedAt,
      });
    });

    return predictions;
  }
}
