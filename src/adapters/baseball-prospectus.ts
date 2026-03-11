import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Baseball Prospectus adapter.
 *
 * STATUS: BROKEN - /gameday/ returns 404 as of 2026-03-10.
 * Baseball Prospectus may require a subscription or the gameday page
 * may only be available during the MLB regular season.
 *
 * Scrapes MLB analytics predictions from baseballprospectus.com.
 * Baseball Prospectus provides PECOTA-based projections and game forecasts:
 *
 * - `.game-forecast, .forecast-card` containers per matchup
 * - `.forecast-card__away, .forecast-card__home` with team names
 * - `.forecast-card__prob` for PECOTA win probability
 * - `.forecast-card__score` for projected score
 * - `.forecast-card__pitchers` for starting pitcher matchup
 * - `.forecast-card__time` for game start time
 * - May use `.standings-table` or `.forecast-table` for tabular data
 */
export class BaseballProspectusAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'baseball-prospectus',
    name: 'Baseball Prospectus',
    baseUrl: 'https://www.baseballprospectus.com',
    fetchMethod: 'http',
    paths: {
      mlb: '/gameday/',
    },
    cron: '0 0 9,14,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Card-based layout
    $('.game-forecast, .forecast-card, .game-card, .matchup').each((_i, el) => {
      const $card = $(el);

      const awayTeamRaw = $card.find('.forecast-card__away .team-name, .away .team-name, .team:first-child').text().trim();
      const homeTeamRaw = $card.find('.forecast-card__home .team-name, .home .team-name, .team:last-child').text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      // PECOTA win probability
      const awayWpText = $card.find('.forecast-card__away .prob, .away .win-pct').text().trim().replace('%', '');
      const homeWpText = $card.find('.forecast-card__home .prob, .home .win-pct').text().trim().replace('%', '');
      const awayWp = parseFloat(awayWpText) || 0;
      const homeWp = parseFloat(homeWpText) || 0;

      // Projected score
      const awayScoreText = $card.find('.forecast-card__away .proj-score, .away .score').text().trim();
      const homeScoreText = $card.find('.forecast-card__home .proj-score, .home .score').text().trim();
      const awayScore = parseFloat(awayScoreText) || 0;
      const homeScore = parseFloat(homeScoreText) || 0;

      // Pitchers
      const awayPitcher = $card.find('.forecast-card__away .pitcher, .away .sp').text().trim();
      const homePitcher = $card.find('.forecast-card__home .pitcher, .home .sp').text().trim();

      const gameTime = $card.find('.forecast-card__time, .game-time').text().trim() || null;

      // Moneyline from win probability
      if (homeWp > 0 || awayWp > 0) {
        const side: Side = homeWp >= awayWp ? 'home' : 'away';
        const winProb = Math.max(homeWp, awayWp);
        const confidence = winProb >= 62 ? 'high' as const
          : winProb >= 54 ? 'medium' as const
          : 'low' as const;

        const pitcherInfo = [awayPitcher, homePitcher].filter(Boolean).join(' vs ');
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
          pickerName: 'Baseball Prospectus PECOTA',
          confidence,
          reasoning: [
            `PECOTA: Home ${homeWp}% / Away ${awayWp}%`,
            pitcherInfo ? `SP: ${pitcherInfo}` : '',
          ].filter(Boolean).join(' | '),
          fetchedAt,
        });
      }

      // Over/under from projected scores
      const totalRuns = awayScore + homeScore;
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
          pickerName: 'Baseball Prospectus PECOTA',
          confidence: 'medium',
          reasoning: `Projected: ${awayTeamRaw} ${awayScore} - ${homeTeamRaw} ${homeScore} (Total: ${totalRuns})`,
          fetchedAt,
        });
      }
    });

    // Fallback: table-based layout
    if (predictions.length === 0) {
      $('table.forecast-table tbody tr, .games-table tbody tr').each((_i, el) => {
        const $row = $(el);
        const cells = $row.find('td');
        if (cells.length < 4) return;

        const awayTeamRaw = cells.eq(0).text().trim();
        const homeTeamRaw = cells.eq(1).text().trim();
        if (!homeTeamRaw || !awayTeamRaw) return;

        const wpText = cells.eq(2).text().trim().replace('%', '');
        const homeWp = parseFloat(wpText) || 50;
        const side: Side = homeWp >= 50 ? 'home' : 'away';

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: today,
          gameTime: null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'Baseball Prospectus PECOTA',
          confidence: homeWp >= 60 ? 'high' : homeWp >= 53 ? 'medium' : 'low',
          reasoning: `PECOTA win probability: ${homeWp}%`,
          fetchedAt,
        });
      });
    }

    return predictions;
  }
}
