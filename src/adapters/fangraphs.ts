import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * FanGraphs adapter.
 *
 * STATUS: BLOCKED BY CLOUDFLARE - /scoreboard returns a Cloudflare Turnstile
 * challenge page even with browser fetch as of 2026-03-10. All snapshots contain
 * only the challenge HTML, no game data. This adapter cannot produce predictions
 * until Cloudflare is bypassed (e.g., via authenticated session or API).
 *
 * Scrapes MLB game projections from fangraphs.com.
 * The scoreboard/projections page shows win probabilities for each game:
 *
 * - `.scoreboard-game` containers for each matchup
 * - `.scoreboard-team` rows with team name and win probability
 * - `.scoreboard-team--away` and `.scoreboard-team--home` classes
 * - Win probability in `.scoreboard-team__wp` element
 * - Game time in `.scoreboard-game__time`
 * - Projected pitchers in `.scoreboard-team__pitcher`
 */
export class FangraphsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'fangraphs',
    name: 'FanGraphs',
    baseUrl: 'https://www.fangraphs.com',
    fetchMethod: 'browser',
    paths: {
      mlb: '/scoreboard',
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

    $('.scoreboard-game, .game-card').each((_i, el) => {
      const $game = $(el);

      // Try to find away and home teams
      const $away = $game.find('.scoreboard-team--away, .team-away').first();
      const $home = $game.find('.scoreboard-team--home, .team-home').first();

      const awayTeamRaw = $away.find('.scoreboard-team__name, .team-name').text().trim();
      const homeTeamRaw = $home.find('.scoreboard-team__name, .team-name').text().trim();

      if (!homeTeamRaw || !awayTeamRaw) return;

      // Win probabilities
      const awayWpText = $away.find('.scoreboard-team__wp, .win-prob').text().trim().replace('%', '');
      const homeWpText = $home.find('.scoreboard-team__wp, .win-prob').text().trim().replace('%', '');
      const awayWp = parseFloat(awayWpText) || 50;
      const homeWp = parseFloat(homeWpText) || 50;

      // Game time
      const gameTime = $game.find('.scoreboard-game__time, .game-time').text().trim() || null;

      // Projected run totals
      const awayRunsText = $away.find('.scoreboard-team__runs, .proj-runs').text().trim();
      const homeRunsText = $home.find('.scoreboard-team__runs, .proj-runs').text().trim();
      const awayRuns = parseFloat(awayRunsText) || 0;
      const homeRuns = parseFloat(homeRunsText) || 0;

      const side: Side = homeWp >= awayWp ? 'home' : 'away';
      const winProb = Math.max(homeWp, awayWp);

      const confidence = winProb >= 62 ? 'high' as const
        : winProb >= 54 ? 'medium' as const
        : 'low' as const;

      // Moneyline pick
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
        pickerName: 'FanGraphs Projections',
        confidence,
        reasoning: `Win prob: Home ${homeWp}% / Away ${awayWp}%`,
        fetchedAt,
      });

      // Over/under pick if projected runs available
      const totalRuns = awayRuns + homeRuns;
      if (totalRuns > 0) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: today,
          gameTime,
          pickType: 'over_under',
          side: totalRuns >= 9 ? 'over' : 'under',
          value: totalRuns,
          pickerName: 'FanGraphs Projections',
          confidence: 'medium',
          reasoning: `Projected total: ${totalRuns} runs (${awayRuns}-${homeRuns})`,
          fetchedAt,
        });
      }
    });

    return predictions;
  }
}
