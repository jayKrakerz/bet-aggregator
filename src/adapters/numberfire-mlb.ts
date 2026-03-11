import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * numberFire MLB adapter.
 *
 * STATUS: BROKEN - /mlb/daily-fantasy/daily-baseball-projections returns a
 * CloudFront "request could not be satisfied" error as of 2026-03-10.
 * The URL may have changed or the page is behind auth/geo-blocking.
 *
 * Scrapes MLB projections from numberfire.com/mlb.
 * numberFire (FanDuel-owned) provides game projections in a table:
 *
 * - `.game-card, .prediction-card` containers per matchup
 * - `.game-card__team--away` and `.game-card__team--home` for teams
 * - `.game-card__wp` or `.win-probability` for win %
 * - `.game-card__spread` for projected run line
 * - `.game-card__total` for projected total runs
 * - `.game-card__time` for start time
 * - Alternatively, `table.projection-table tr` rows with projection data
 */
export class NumberfireMlbAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'numberfire-mlb',
    name: 'numberFire MLB',
    baseUrl: 'https://www.numberfire.com',
    fetchMethod: 'http',
    paths: {
      mlb: '/mlb/daily-fantasy/daily-baseball-projections',
    },
    cron: '0 0 9,14,18 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Try card-based layout first
    $('.game-card, .prediction-card, .matchup-card').each((_i, el) => {
      const $card = $(el);

      const awayTeamRaw = $card.find('.game-card__team--away .team-name, .away .team-name').text().trim();
      const homeTeamRaw = $card.find('.game-card__team--home .team-name, .home .team-name').text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      const awayWpText = $card.find('.game-card__team--away .win-probability, .away .wp').text().trim().replace('%', '');
      const homeWpText = $card.find('.game-card__team--home .win-probability, .home .wp').text().trim().replace('%', '');
      const awayWp = parseFloat(awayWpText) || 50;
      const homeWp = parseFloat(homeWpText) || 50;

      const gameTime = $card.find('.game-card__time, .game-time').text().trim() || null;

      // Spread / run line
      const spreadText = $card.find('.game-card__spread, .spread').text().trim();
      const spreadVal = this.parseSpreadValue(spreadText);

      // Total
      const totalText = $card.find('.game-card__total, .total').text().trim();
      const totalVal = this.parseTotalValue(totalText);

      const side: Side = homeWp >= awayWp ? 'home' : 'away';
      const winProb = Math.max(homeWp, awayWp);
      const confidence = winProb >= 60 ? 'high' as const
        : winProb >= 53 ? 'medium' as const
        : 'low' as const;

      // Moneyline prediction
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
        pickerName: 'numberFire',
        confidence,
        reasoning: `Win prob: Home ${homeWp}% / Away ${awayWp}%`,
        fetchedAt,
      });

      // Run line prediction
      if (spreadVal !== null) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: today,
          gameTime,
          pickType: 'spread',
          side: spreadVal < 0 ? 'home' : 'away',
          value: spreadVal,
          pickerName: 'numberFire',
          confidence: 'medium',
          reasoning: `Projected run line: ${spreadText}`,
          fetchedAt,
        });
      }

      // Over/under prediction
      if (totalVal !== null) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: today,
          gameTime,
          pickType: 'over_under',
          side: totalVal >= 9 ? 'over' : 'under',
          value: totalVal,
          pickerName: 'numberFire',
          confidence: 'medium',
          reasoning: `Projected total: ${totalVal} runs`,
          fetchedAt,
        });
      }
    });

    // Fallback: table-based layout
    if (predictions.length === 0) {
      $('table.projection-table tbody tr, .games-table tbody tr').each((_i, el) => {
        const $row = $(el);
        const cells = $row.find('td');
        if (cells.length < 4) return;

        const awayTeamRaw = cells.eq(0).text().trim();
        const homeTeamRaw = cells.eq(1).text().trim();
        if (!homeTeamRaw || !awayTeamRaw) return;

        const wpText = cells.eq(2).text().trim().replace('%', '');
        const wp = parseFloat(wpText) || 50;
        const side: Side = wp >= 50 ? 'home' : 'away';

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
          pickerName: 'numberFire',
          confidence: wp >= 60 ? 'high' : wp >= 53 ? 'medium' : 'low',
          reasoning: `Win probability: ${wp}%`,
          fetchedAt,
        });
      });
    }

    return predictions;
  }
}
