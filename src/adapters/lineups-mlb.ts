import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Lineups.com MLB adapter.
 *
 * STATUS: UNFIXABLE (404) - As of 2026-03-10, the /mlb/picks URL returns
 * a "Page Not Found" error page. The site appears to have restructured
 * or removed the picks page. The snapshot title is "Error - Page Not Found"
 * and the body contains only generic navigation (NFL, NBA, etc.) and
 * Cloudflare overlay elements. No game/pick data is present.
 *
 * If the page becomes available again, the selectors below should be
 * updated to match the new DOM structure.
 */
export class LineupsMlbAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'lineups-mlb',
    name: 'Lineups.com MLB',
    baseUrl: 'https://www.lineups.com',
    fetchMethod: 'browser',
    paths: {
      mlb: '/mlb/picks',
    },
    cron: '0 0 9,13,17 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    $('.matchup-card, .game-card, .picks-matchup').each((_i, el) => {
      const $card = $(el);

      const awayTeamRaw = $card.find('.team-info--away .team-name, .away-team').text().trim();
      const homeTeamRaw = $card.find('.team-info--home .team-name, .home-team').text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      const gameTime = $card.find('.game-meta__time, .game-time, .start-time').text().trim() || null;

      // Moneyline pick
      const mlPick = $card.find('.pick-indicator.moneyline .selected, .ml-pick .recommended-pick').text().trim();
      if (mlPick) {
        const side = this.resolveSide(mlPick, homeTeamRaw, awayTeamRaw);
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
          pickerName: 'Lineups.com',
          confidence: 'medium',
          reasoning: null,
          fetchedAt,
        });
      }

      // Run line / spread pick
      const spreadText = $card.find('.spread-value, .run-line').text().trim();
      const spreadPick = $card.find('.pick-indicator.spread .selected, .rl-pick .recommended-pick').text().trim();
      if (spreadPick) {
        const spreadVal = this.parseSpreadValue(spreadText);
        const side = this.resolveSide(spreadPick, homeTeamRaw, awayTeamRaw);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: today,
          gameTime,
          pickType: 'spread',
          side,
          value: spreadVal,
          pickerName: 'Lineups.com',
          confidence: 'medium',
          reasoning: spreadText ? `Run line: ${spreadText}` : null,
          fetchedAt,
        });
      }

      // Over/under pick
      const totalText = $card.find('.total-value, .ou-value').text().trim();
      const ouPick = $card.find('.pick-indicator.total .selected, .ou-pick .recommended-pick').text().trim();
      if (ouPick) {
        const totalVal = this.parseTotalValue(totalText);
        const side: Side = ouPick.toLowerCase().includes('over') ? 'over' : 'under';
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: today,
          gameTime,
          pickType: 'over_under',
          side,
          value: totalVal,
          pickerName: 'Lineups.com',
          confidence: 'medium',
          reasoning: totalText ? `Total: ${totalText}` : null,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private resolveSide(pick: string, home: string, away: string): Side {
    const pLower = pick.toLowerCase();
    if (pLower.includes('over')) return 'over';
    if (pLower.includes('under')) return 'under';
    const hLower = home.toLowerCase();
    const aLower = away.toLowerCase();
    if (pLower.includes(hLower) || hLower.includes(pLower)) return 'home';
    if (pLower.includes(aLower) || aLower.includes(pLower)) return 'away';
    return 'home';
  }
}
