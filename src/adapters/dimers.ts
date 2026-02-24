import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Dimers adapter.
 *
 * Dimers is an Angular SSR app that runs Monte Carlo simulations for each game.
 * Requires browser rendering for Angular hydration.
 *
 * Actual page structure (as of 2026-02):
 *   - `div.game-sport-group` — groups games by sport
 *   - `a.game-link` — one per game, clickable row
 *     - `[data-match-id]` — e.g. "NBA_2025_127_IND_PHI"
 *     - `[data-match-status]` — "upcoming" | "completed"
 *     - `div.away-team` / `div.home-team` — team containers
 *       - `div.team-name` — team abbreviation (e.g. "PHI")
 *       - `div.team-prob` — win probability (e.g. "77%")
 *       - `div.team-line` — spread line (e.g. "-9.5")
 *     - `div.game-info` — game time (e.g. "12AM, Feb 25")
 */
export class DimersAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'dimers',
    name: 'Dimers',
    baseUrl: 'https://www.dimers.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/bet-hub/nba/schedule',
      nfl: '/bet-hub/nfl/schedule',
      mlb: '/bet-hub/mlb/schedule',
      nhl: '/bet-hub/nhl/schedule',
    },
    cron: '0 0 9,13,17,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('a.game-link, div.game-sport-group', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    const gameDate = fetchedAt.toISOString().split('T')[0]!;

    $('a.game-link').each((_i, el) => {
      const link = $(el);

      // Filter by sport using data-match-id (e.g., "NBA_2025_127_IND_PHI")
      const matchId = link.attr('data-match-id') || '';
      const matchSport = matchId.split('_')[0]?.toLowerCase();
      if (matchSport && matchSport !== sport.toLowerCase() && matchSport !== this.sportAlias(sport)) return;

      // Skip completed games
      const matchStatus = link.attr('data-match-status') || '';
      if (matchStatus === 'completed' || matchStatus === 'final') return;

      const awayTeamRaw = link.find('.away-team .team-name').text().trim();
      const homeTeamRaw = link.find('.home-team .team-name').text().trim();

      if (!awayTeamRaw || !homeTeamRaw) return;

      const gameTime = link.find('.game-info').text().trim() || null;

      // Win probabilities
      const awayProbText = link.find('.away-team .team-prob').text().trim();
      const homeProbText = link.find('.home-team .team-prob').text().trim();
      const awayProb = this.parseProb(awayProbText);
      const homeProb = this.parseProb(homeProbText);

      // Spread lines
      const awayLine = link.find('.away-team .team-line').text().trim();
      const homeLine = link.find('.home-team .team-line').text().trim();

      // Moneyline pick from win probabilities
      if (awayProb != null && homeProb != null && (awayProb !== homeProb)) {
        const side: Side = homeProb > awayProb ? 'home' : 'away';
        const prob = Math.max(homeProb, awayProb);

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
          pickerName: 'Dimers Model',
          confidence: this.mapWinProbToConfidence(prob),
          reasoning: `Win prob: ${awayTeamRaw} ${awayProb}%, ${homeTeamRaw} ${homeProb}%`,
          fetchedAt,
        });
      }

      // Spread pick from spread lines
      const spreadVal = this.extractSpread(homeLine || awayLine);
      if (spreadVal != null && awayProb != null && homeProb != null) {
        const side: Side = homeProb > awayProb ? 'home' : 'away';

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'spread',
          side,
          value: side === 'home' ? this.extractSpread(homeLine) : this.extractSpread(awayLine),
          pickerName: 'Dimers Model',
          confidence: this.mapWinProbToConfidence(Math.max(awayProb, homeProb)),
          reasoning: `Spread: ${awayTeamRaw} ${awayLine}, ${homeTeamRaw} ${homeLine}`,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private sportAlias(sport: string): string {
    const aliases: Record<string, string> = {
      nba: 'nba', nfl: 'nfl', mlb: 'mlb', nhl: 'nhl',
    };
    return aliases[sport.toLowerCase()] || sport.toLowerCase();
  }

  private parseProb(text: string): number | null {
    const match = text.match(/([\d.]+)/);
    return match ? parseFloat(match[1]!) : null;
  }

  private extractSpread(lineText: string): number | null {
    const match = lineText.match(/([+-]?\d+\.?\d*)/);
    return match ? parseFloat(match[1]!) : null;
  }

  private mapWinProbToConfidence(prob: number | null): Confidence | null {
    if (prob == null) return null;
    if (prob >= 75) return 'best_bet';
    if (prob >= 65) return 'high';
    if (prob >= 55) return 'medium';
    return 'low';
  }
}
