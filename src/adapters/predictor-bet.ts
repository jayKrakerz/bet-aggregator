import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Predictor.bet adapter.
 *
 * STATUS: BROKEN - /predictions/today returns 404 as of 2026-03-10.
 * The domain may be defunct or the URL has changed.
 *
 * ML-powered soccer prediction site. Predictions page shows a table of
 * upcoming matches with predicted outcomes and confidence scores.
 *
 * Structure:
 *   - Prediction cards/rows: `.prediction-card` or `tr.match-row`
 *   - Teams: `.home-team` / `.away-team` or within table cells
 *   - Prediction: `.prediction-result` with "1", "X", or "2"
 *   - Confidence: `.confidence-score` or percentage bar
 *   - Date: `.match-date` with ISO or DD/MM format
 */
export class PredictorBetAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'predictor-bet',
    name: 'Predictor',
    baseUrl: 'https://predictor.bet',
    fetchMethod: 'http',
    paths: {
      football: '/predictions/today',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Try card-based layout
    $('.prediction-card, .match-prediction, tr.match-row').each((_i, el) => {
      const $el = $(el);

      const homeTeam = $el.find('.home-team, .team-home, td:nth-child(2)').first().text().trim();
      const awayTeam = $el.find('.away-team, .team-away, td:nth-child(4)').first().text().trim();
      if (!homeTeam || !awayTeam) return;

      const predText = $el.find('.prediction-result, .pred, .tip').first().text().trim();
      const side = this.mapPrediction(predText);
      if (!side) return;

      const confText = $el.find('.confidence-score, .confidence, .prob').first().text().trim();
      const confNum = parseInt(confText, 10);
      const confidence = this.mapConfidence(confNum);

      const dateText = $el.find('.match-date, .date, time').first().text().trim();
      const gameDate = this.extractDate(dateText, fetchedAt);

      const league = $el.find('.league, .competition').first().text().trim();

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate,
        gameTime: null,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'Predictor ML',
        confidence,
        reasoning: league || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private mapPrediction(text: string): Side | null {
    const t = text.trim();
    if (t === '1') return 'home';
    if (t === '2') return 'away';
    if (t === 'X' || t === 'x') return 'draw';
    if (/home/i.test(t)) return 'home';
    if (/away/i.test(t)) return 'away';
    if (/draw/i.test(t)) return 'draw';
    return null;
  }

  private mapConfidence(prob: number): Confidence | null {
    if (isNaN(prob)) return null;
    if (prob >= 75) return 'best_bet';
    if (prob >= 60) return 'high';
    if (prob >= 45) return 'medium';
    return 'low';
  }

  private extractDate(text: string, fetchedAt: Date): string {
    const isoMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1]!;

    const dmMatch = text.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
    if (dmMatch) {
      return `${dmMatch[3]}-${dmMatch[2]!.padStart(2, '0')}-${dmMatch[1]!.padStart(2, '0')}`;
    }

    return fetchedAt.toISOString().split('T')[0]!;
  }
}
