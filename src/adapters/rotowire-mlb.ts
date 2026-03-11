import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * RotoWire MLB adapter.
 *
 * STATUS: BROKEN - /baseball/daily-lineups/ returns 404 ("File Not Found")
 * as of 2026-03-10. The URL may have changed; try /baseball/daily-lineups.php
 * or the page may only be live during the MLB season.
 *
 * Scrapes MLB predictions and daily lineups from rotowire.com/baseball.
 * RotoWire provides game-by-game predictions with expert analysis:
 *
 * - `.game-card, .game-info` containers per matchup
 * - `.lineup-card__teams` with away/home team info
 * - `.lineup-card__prob` for win probability
 * - `.lineup-card__pick` for expert pick
 * - `.lineup-card__pitcher` for starting pitchers
 * - `.lineup-card__time` for game time
 * - `.expert-pick__text` for analysis text
 * - May also parse from `.odds-table` for spread/total data
 */
export class RotowireMlbAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'rotowire-mlb',
    name: 'RotoWire MLB',
    baseUrl: 'https://www.rotowire.com',
    fetchMethod: 'http',
    paths: {
      mlb: '/baseball/daily-lineups/',
    },
    cron: '0 0 9,13,17 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    $('.lineup-card, .game-card, .game-info').each((_i, el) => {
      const $card = $(el);

      // Team names
      const awayTeamRaw = $card.find('.lineup-card__team--away .team-name, .is-visit .lineup-card__team-name').text().trim();
      const homeTeamRaw = $card.find('.lineup-card__team--home .team-name, .is-home .lineup-card__team-name').text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Game time
      const gameTime = $card.find('.lineup-card__time, .game-time').text().trim() || null;

      // Starting pitchers
      const awayPitcher = $card.find('.is-visit .lineup-card__pitcher-name, .away-pitcher').text().trim();
      const homePitcher = $card.find('.is-home .lineup-card__pitcher-name, .home-pitcher').text().trim();

      // Win probability
      const awayWpText = $card.find('.is-visit .lineup-card__prob, .away-prob').text().trim().replace('%', '');
      const homeWpText = $card.find('.is-home .lineup-card__prob, .home-prob').text().trim().replace('%', '');
      const awayWp = parseFloat(awayWpText) || 0;
      const homeWp = parseFloat(homeWpText) || 0;

      // Odds data
      const spreadText = $card.find('.lineup-card__spread, .odds-spread').text().trim();
      const totalText = $card.find('.lineup-card__total, .odds-total').text().trim();
      const mlText = $card.find('.lineup-card__moneyline, .odds-ml').text().trim();

      const pitcherInfo = [awayPitcher, homePitcher].filter(Boolean).join(' vs ');

      // Moneyline pick if win probability available
      if (homeWp > 0 || awayWp > 0) {
        const side: Side = homeWp >= awayWp ? 'home' : 'away';
        const winProb = Math.max(homeWp, awayWp);
        const confidence = winProb >= 60 ? 'high' as const
          : winProb >= 53 ? 'medium' as const
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
          value: this.parseMoneylineValue(mlText),
          pickerName: 'RotoWire',
          confidence,
          reasoning: [
            `Win prob: ${homeWp}%/${awayWp}%`,
            pitcherInfo ? `SP: ${pitcherInfo}` : '',
          ].filter(Boolean).join(' | '),
          fetchedAt,
        });
      }

      // Run line / spread
      if (spreadText) {
        const spreadVal = this.parseSpreadValue(spreadText);
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
            pickerName: 'RotoWire',
            confidence: 'medium',
            reasoning: `Run line: ${spreadText}${pitcherInfo ? ` | SP: ${pitcherInfo}` : ''}`,
            fetchedAt,
          });
        }
      }

      // Over/under
      if (totalText) {
        const totalVal = this.parseTotalValue(totalText);
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
            pickerName: 'RotoWire',
            confidence: 'medium',
            reasoning: `Total: ${totalText}`,
            fetchedAt,
          });
        }
      }
    });

    return predictions;
  }
}
