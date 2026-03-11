import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * WagerGnome adapter.
 *
 * WagerGnome.com provides computer-generated NBA picks based
 * on statistical models and simulations.
 *
 * Page structure:
 * - `.game-card, .pick-row`: game prediction container
 * - `.teams .away, .teams .home`: team names
 * - `.computer-pick`: the model's recommended pick
 * - `.pick-spread, .pick-total, .pick-ml`: specific pick types
 * - `.model-confidence, .confidence-pct`: model confidence
 * - `.projected-score`: projected final score
 * - `.game-date`: date of the game
 */
export class WagergnomeAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'wagergnome',
    name: 'WagerGnome',
    baseUrl: 'https://wagergnome.com',
    fetchMethod: 'http',
    paths: {
      nba: '/nba/',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    $('.game-card, .pick-row, .prediction-card, .matchup-row').each((_i, el) => {
      const $card = $(el);

      // Extract teams
      const awayTeamRaw = $card.find('.teams .away, .away-team, .team-away').text().trim();
      const homeTeamRaw = $card.find('.teams .home, .home-team, .team-home').text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      const dateText = $card.find('.game-date, .date, time').text().trim();
      const gameDate = this.extractDate(dateText) || todayStr;

      // Projected score
      const awayProj = parseFloat($card.find('.projected-score .away, .proj-away').text().trim()) || 0;
      const homeProj = parseFloat($card.find('.projected-score .home, .proj-home').text().trim()) || 0;

      // Confidence
      const confText = $card.find('.model-confidence, .confidence-pct, .confidence').text().trim();
      const confidence = this.parseModelConfidence(confText);

      // Spread pick
      const spreadText = $card.find('.pick-spread, .spread-pick').text().trim();
      if (spreadText) {
        const spreadVal = this.parseSpreadValue(spreadText);
        const side = this.resolveTeamSide(spreadText, awayTeamRaw, homeTeamRaw);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime: null,
          pickType: 'spread',
          side,
          value: spreadVal,
          pickerName: 'WagerGnome Computer',
          confidence,
          reasoning: awayProj && homeProj
            ? `Projected: ${awayTeamRaw} ${awayProj} - ${homeTeamRaw} ${homeProj}`
            : `Spread: ${spreadText}`,
          fetchedAt,
        });
      }

      // Total pick
      const totalText = $card.find('.pick-total, .total-pick').text().trim();
      if (totalText) {
        const totalVal = this.parseTotalValue(totalText);
        const ouSide: Side = totalText.toLowerCase().includes('under') ? 'under' : 'over';
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime: null,
          pickType: 'over_under',
          side: ouSide,
          value: totalVal,
          pickerName: 'WagerGnome Computer',
          confidence,
          reasoning: awayProj && homeProj
            ? `Projected total: ${(awayProj + homeProj).toFixed(1)}`
            : `Total: ${totalText}`,
          fetchedAt,
        });
      }

      // Moneyline pick
      const mlText = $card.find('.pick-ml, .computer-pick, .ml-pick').text().trim();
      if (mlText || (!spreadText && !totalText)) {
        const side = awayProj > homeProj ? 'away' as const
          : homeProj > awayProj ? 'home' as const
          : this.resolveTeamSide(mlText, awayTeamRaw, homeTeamRaw);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime: null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'WagerGnome Computer',
          confidence,
          reasoning: awayProj && homeProj
            ? `Projected: ${awayTeamRaw} ${awayProj} - ${homeTeamRaw} ${homeProj}`
            : mlText ? `Pick: ${mlText}` : null,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private resolveTeamSide(text: string, away: string, home: string): Side {
    const lower = text.toLowerCase();
    const awayLast = away.toLowerCase().split(' ').pop()!;
    const homeLast = home.toLowerCase().split(' ').pop()!;
    if (lower.includes(awayLast)) return 'away';
    if (lower.includes(homeLast)) return 'home';
    return 'home';
  }

  /** Parse model confidence from percentage or descriptive text. */
  private parseModelConfidence(text: string): 'low' | 'medium' | 'high' | 'best_bet' | null {
    if (!text) return null;
    const pctMatch = text.match(/(\d+)\s*%/);
    if (pctMatch) {
      const pct = parseInt(pctMatch[1]!, 10);
      if (pct >= 80) return 'best_bet';
      if (pct >= 65) return 'high';
      if (pct >= 50) return 'medium';
      return 'low';
    }
    return this.inferConfidence(text);
  }

  private extractDate(text: string): string | null {
    const match = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (!match) return null;
    const month = match[1]!.padStart(2, '0');
    const day = match[2]!.padStart(2, '0');
    const year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : String(new Date().getFullYear());
    return `${year}-${month}-${day}`;
  }
}
