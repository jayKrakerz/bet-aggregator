import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Swish Analytics adapter.
 *
 * STATUS: URL returns empty HTML response with no prediction content.
 * The site may require authentication or the path has changed.
 *
 * SwishAnalytics provides AI-powered NBA predictions with projected
 * scores, spreads, and over/under totals.
 *
 * Page structure:
 * - `.matchup-card, .game-card`: game container
 * - `.team-away .team-name`, `.team-home .team-name`: team names
 * - `.projected-score`: projected score for each team
 * - `.pick-recommendation`: spread/total/moneyline pick
 * - `.confidence-meter, .confidence-rating`: confidence level
 * - `.game-info .game-time`: scheduled time
 */
export class SwishAnalyticsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'swish-analytics',
    name: 'Swish Analytics',
    baseUrl: 'https://swishanalytics.com',
    fetchMethod: 'http',
    paths: {
      nba: '/nba/predictions',
    },
    cron: '0 0 9,15,21 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('.matchup-card, .game-card, .prediction-row').each((_i, el) => {
      const $card = $(el);

      const awayTeamRaw = $card.find('.team-away .team-name, .away-team').text().trim();
      const homeTeamRaw = $card.find('.team-home .team-name, .home-team').text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      const timeText = $card.find('.game-time, .game-info time, .event-date').text().trim();
      const gameDate = this.extractDate(timeText, fetchedAt);
      const gameTime = timeText || null;

      // Projected scores
      const projScores = $card.find('.projected-score, .proj-score');
      let awayProj = 0;
      let homeProj = 0;
      if (projScores.length >= 2) {
        awayProj = parseFloat($(projScores[0]).text().trim()) || 0;
        homeProj = parseFloat($(projScores[1]).text().trim()) || 0;
      }

      // Moneyline pick from projected scores
      if (homeProj > 0 || awayProj > 0) {
        const side: Side = homeProj >= awayProj ? 'home' : 'away';
        const margin = Math.abs(homeProj - awayProj);
        const confidence = margin >= 10 ? 'high' as const
          : margin >= 5 ? 'medium' as const
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
          pickerName: 'Swish Analytics AI',
          confidence,
          reasoning: `Projected: ${awayTeamRaw} ${awayProj} - ${homeTeamRaw} ${homeProj}`,
          fetchedAt,
        });

        // Spread pick from projected margin
        if (margin > 0) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'spread',
            side,
            value: side === 'home' ? -margin : margin,
            pickerName: 'Swish Analytics AI',
            confidence,
            reasoning: `Projected margin: ${margin.toFixed(1)}`,
            fetchedAt,
          });
        }

        // Over/under from projected total
        const projTotal = homeProj + awayProj;
        if (projTotal > 0) {
          const lineText = $card.find('.total-line, .ou-line, .game-total').text().trim();
          const line = this.parseTotalValue(lineText);

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'over_under',
            side: line && projTotal > line ? 'over' : 'under',
            value: line ?? projTotal,
            pickerName: 'Swish Analytics AI',
            confidence: null,
            reasoning: `Projected total: ${projTotal.toFixed(1)}`,
            fetchedAt,
          });
        }
      }

      // Also check for explicit pick recommendations
      const pickText = $card.find('.pick-recommendation, .best-pick').text().trim();
      if (pickText && homeProj === 0 && awayProj === 0) {
        const pickType = this.inferPickType(pickText);
        const side: Side = pickText.toLowerCase().includes('under') ? 'under'
          : pickText.toLowerCase().includes('over') ? 'over'
          : pickText.toLowerCase().includes(awayTeamRaw.toLowerCase()) ? 'away'
          : 'home';

        const confText = $card.find('.confidence-meter, .confidence-rating').text().trim();

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType,
          side,
          value: null,
          pickerName: 'Swish Analytics AI',
          confidence: this.inferConfidence(confText),
          reasoning: pickText.slice(0, 300) || null,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

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
