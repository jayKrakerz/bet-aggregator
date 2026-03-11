import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction } from '../types/prediction.js';

/**
 * NumberFire adapter.
 *
 * NumberFire (owned by FanDuel) provides NBA game predictions
 * powered by statistical models similar to FiveThirtyEight.
 *
 * STATUS: Site returns 403 via CloudFront CDN. Changed to browser
 * fetch to attempt bypassing, but may still be blocked.
 *
 * Page structure:
 * - `.prediction-card` or `.game-card`: each game container
 * - `.team-name`: team names (home/away order)
 * - `.win-probability`: percentage win chance per team
 * - `.spread-pick`, `.total-pick`: spread and total predictions
 * - `.game-time`: scheduled game time
 */
export class NumberfireAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'numberfire',
    name: 'NumberFire',
    baseUrl: 'https://www.numberfire.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/nba/games',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // NumberFire uses game prediction cards with win probabilities
    $('.game-card, .prediction-card, .game-item').each((_i, el) => {
      const $card = $(el);

      // Extract team names
      const teams = $card.find('.team-name, .team__name, .team-info__name');
      if (teams.length < 2) return;
      const awayTeamRaw = $(teams[0]).text().trim();
      const homeTeamRaw = $(teams[1]).text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Extract game date/time
      const timeText = $card.find('.game-time, .game-date, .event-time').text().trim();
      const gameDate = this.extractDate(timeText, fetchedAt);
      const gameTime = timeText || null;

      // Extract win probabilities
      const probElements = $card.find('.win-probability, .win-prob, .probability');
      let homeProb = 0;
      if (probElements.length >= 2) {
        homeProb = parseFloat($(probElements[1]).text().replace('%', '').trim()) || 0;
      }
      const side = homeProb >= 50 ? 'home' as const : 'away' as const;
      const winProb = homeProb >= 50 ? homeProb : 100 - homeProb;

      // Determine confidence from win probability
      const confidence = winProb >= 70 ? 'best_bet' as const
        : winProb >= 60 ? 'high' as const
        : winProb >= 55 ? 'medium' as const
        : 'low' as const;

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
        pickerName: 'NumberFire Model',
        confidence,
        reasoning: winProb > 0 ? `Win probability: ${winProb.toFixed(1)}%` : null,
        fetchedAt,
      });

      // Extract spread prediction if available
      const spreadText = $card.find('.spread-pick, .spread-value, .spread').text().trim();
      if (spreadText) {
        const spreadVal = this.parseSpreadValue(spreadText);
        if (spreadVal !== null) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'spread',
            side,
            value: spreadVal,
            pickerName: 'NumberFire Model',
            confidence,
            reasoning: `Projected spread: ${spreadText}`,
            fetchedAt,
          });
        }
      }

      // Extract over/under prediction if available
      const totalText = $card.find('.total-pick, .total-value, .over-under').text().trim();
      if (totalText) {
        const totalVal = this.parseTotalValue(totalText);
        const ouSide = totalText.toLowerCase().includes('under') ? 'under' as const : 'over' as const;
        if (totalVal !== null) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'over_under',
            side: ouSide,
            value: totalVal,
            pickerName: 'NumberFire Model',
            confidence: null,
            reasoning: `Projected total: ${totalText}`,
            fetchedAt,
          });
        }
      }
    });

    return predictions;
  }

  /** Extract ISO date from time text, falling back to fetchedAt. */
  private extractDate(text: string, fetchedAt: Date): string {
    const match = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (match) {
      const month = match[1]!.padStart(2, '0');
      const day = match[2]!.padStart(2, '0');
      const year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : String(fetchedAt.getFullYear());
      return `${year}-${month}-${day}`;
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
