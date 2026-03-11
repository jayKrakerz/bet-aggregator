import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * WagerGnome MLB adapter.
 *
 * Scrapes MLB computer picks from wagergnome.com/mlb.
 * WagerGnome provides algorithm-generated picks with ratings:
 *
 * - `.pick-row, .game-row` containers per matchup
 * - `.pick-row__away, .pick-row__home` with team names
 * - `.pick-row__rating` for computer confidence rating (1-10 scale)
 * - `.pick-row__pick` for the recommended side
 * - `.pick-row__spread, .pick-row__total, .pick-row__ml` for market values
 * - `.pick-row__time` for game time
 * - `.pick-row__analysis` for computer model reasoning
 */
export class WagerGnomeMlbAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'wagergnome-mlb',
    name: 'WagerGnome MLB',
    baseUrl: 'https://wagergnome.com',
    fetchMethod: 'http',
    paths: {
      mlb: '/mlb/',
    },
    cron: '0 0 9,13,17 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    $('.pick-row, .game-row, .prediction-row, .pick-card').each((_i, el) => {
      const $row = $(el);

      const awayTeamRaw = $row.find('.pick-row__away .team-name, .away .name, .team-away').text().trim();
      const homeTeamRaw = $row.find('.pick-row__home .team-name, .home .name, .team-home').text().trim();

      if (!homeTeamRaw || !awayTeamRaw) {
        // Fallback: matchup text
        const matchText = $row.find('.matchup, .teams, h3').first().text().trim();
        const parsed = this.parseMatchup(matchText);
        if (!parsed) return;
        return; // can't reassign const
      }

      const gameTime = $row.find('.pick-row__time, .game-time, .time').text().trim() || null;

      // Computer rating (1-10)
      const ratingText = $row.find('.pick-row__rating, .rating, .score').text().trim();
      const rating = parseFloat(ratingText) || 0;
      const confidence = this.ratingToConfidence(rating);

      // Analysis
      const reasoning = $row.find('.pick-row__analysis, .analysis, .model-text, p').first().text().trim().slice(0, 300) || null;

      // Moneyline pick
      const mlPick = $row.find('.pick-row__ml .pick, .ml-pick, .moneyline-pick').text().trim();
      if (mlPick) {
        const side = this.resolveSide(mlPick, homeTeamRaw, awayTeamRaw);
        const mlVal = this.parseMoneylineValue(mlPick);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: today,
          gameTime,
          pickType: 'moneyline',
          side,
          value: mlVal,
          pickerName: 'WagerGnome Computer',
          confidence,
          reasoning: rating ? `Rating: ${rating}/10${reasoning ? ` | ${reasoning}` : ''}` : reasoning,
          fetchedAt,
        });
      }

      // Spread / run line pick
      const spreadPick = $row.find('.pick-row__spread .pick, .spread-pick, .rl-pick').text().trim();
      if (spreadPick) {
        const spreadVal = this.parseSpreadValue(spreadPick);
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
          pickerName: 'WagerGnome Computer',
          confidence,
          reasoning: rating ? `Rating: ${rating}/10` : null,
          fetchedAt,
        });
      }

      // Over/under pick
      const ouPick = $row.find('.pick-row__total .pick, .total-pick, .ou-pick').text().trim();
      if (ouPick) {
        const totalVal = this.parseTotalValue(ouPick);
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
          pickerName: 'WagerGnome Computer',
          confidence,
          reasoning: rating ? `Rating: ${rating}/10` : null,
          fetchedAt,
        });
      }

      // If no specific market picks found, try generic pick
      if (!mlPick && !spreadPick && !ouPick) {
        const genericPick = $row.find('.pick, .selection, .recommended').first().text().trim();
        if (genericPick) {
          const pickType = this.inferPickType(genericPick);
          const side = this.resolveSide(genericPick, homeTeamRaw, awayTeamRaw);
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate: today,
            gameTime,
            pickType,
            side,
            value: null,
            pickerName: 'WagerGnome Computer',
            confidence,
            reasoning: rating ? `Rating: ${rating}/10` : reasoning,
            fetchedAt,
          });
        }
      }
    });

    return predictions;
  }

  private parseMatchup(text: string): { home: string; away: string } | null {
    const match = text.match(/^(.+?)\s+(?:vs\.?|@|at)\s+(.+?)$/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
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

  private ratingToConfidence(rating: number): RawPrediction['confidence'] {
    if (rating >= 9) return 'best_bet';
    if (rating >= 7) return 'high';
    if (rating >= 5) return 'medium';
    if (rating >= 1) return 'low';
    return null;
  }
}
