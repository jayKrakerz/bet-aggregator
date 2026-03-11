import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Predictor.bet adapter.
 *
 * Predictor.bet uses machine learning models for soccer predictions.
 *
 * Expected page structure (likely SPA with some SSR):
 * - Predictions in `.prediction-list` or `.matches-container`
 * - Each match card: `.match-card` or `.prediction-item`
 * - Card contents:
 *   - `.teams .home` / `.teams .away`: team names
 *   - `.league-badge` or `.league`: competition
 *   - `.date-time`: match date and kickoff
 *   - `.ml-prediction` or `.ai-pick`: ML model output
 *   - `.probability-bar`: visual bar with home/draw/away percentages
 *   - `.prob-home`, `.prob-draw`, `.prob-away`: individual probability values
 *   - `.model-confidence`: confidence score from the ML model
 *   - `.predicted-score`: ML predicted final score
 *
 * The ML model output typically includes a confidence percentage and
 * predicted scoreline, making this a high-quality prediction source.
 */
export class PredictorAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'predictor',
    name: 'Predictor.bet',
    baseUrl: 'https://predictor.bet',
    fetchMethod: 'http',
    paths: {
      football: '/predictions/football/',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('.match-card, .prediction-item, .match-prediction, [data-match]').each((_i, el) => {
      const $el = $(el);

      const homeTeam = $el.find('.home, .team-home, .teams .home').text().trim();
      const awayTeam = $el.find('.away, .team-away, .teams .away').text().trim();
      if (!homeTeam || !awayTeam) return;

      // Extract probabilities
      const probHome = this.extractPct($el.find('.prob-home, .home-prob, [data-prob-home]').text());
      const probDraw = this.extractPct($el.find('.prob-draw, .draw-prob, [data-prob-draw]').text());
      const probAway = this.extractPct($el.find('.prob-away, .away-prob, [data-prob-away]').text());

      // Get ML prediction
      const mlPick = $el.find('.ml-prediction, .ai-pick, .prediction, .pick').text().trim();
      const side = this.resolveSide(mlPick, probHome, probDraw, probAway);
      if (!side) return;

      // Additional context
      const league = $el.find('.league-badge, .league, .competition').text().trim();
      const dateTimeText = $el.find('.date-time, .date, .match-date').text().trim();
      const { gameDate, gameTime } = this.parseDateTime(dateTimeText, fetchedAt);
      const predictedScore = $el.find('.predicted-score, .score-prediction').text().trim();
      const modelConfText = $el.find('.model-confidence, .confidence').text().trim();
      const modelConf = this.extractPct(modelConfText);

      const confidence = this.computeConfidence(modelConf, probHome, probDraw, probAway, side);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'Predictor ML',
        confidence,
        reasoning: [
          league,
          !isNaN(probHome) && !isNaN(probDraw) && !isNaN(probAway)
            ? `ML Prob: ${probHome}/${probDraw}/${probAway}`
            : '',
          predictedScore ? `Predicted: ${predictedScore}` : '',
          !isNaN(modelConf) ? `Model confidence: ${modelConf}%` : '',
        ].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    // Fallback: table layout
    if (predictions.length === 0) {
      $('table tbody tr').each((_i, el) => {
        const cells = $(el).find('td');
        if (cells.length < 6) return;

        const homeTeam = $(cells[1]).text().trim();
        const awayTeam = $(cells[2]).text().trim();
        if (!homeTeam || !awayTeam) return;

        const p1 = this.extractPct($(cells[3]).text());
        const pX = this.extractPct($(cells[4]).text());
        const p2 = this.extractPct($(cells[5]).text());

        const side = this.resolveSide('', p1, pX, p2);
        if (!side) return;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate: fetchedAt.toISOString().split('T')[0]!,
          gameTime: $(cells[0]).text().trim() || null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'Predictor ML',
          confidence: this.computeConfidence(NaN, p1, pX, p2, side),
          reasoning: !isNaN(p1) ? `ML Prob: ${p1}/${pX}/${p2}` : null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private extractPct(text: string): number {
    const match = text.trim().match(/(\d+(?:\.\d+)?)/);
    return match ? parseFloat(match[1]!) : NaN;
  }

  private resolveSide(pick: string, p1: number, pX: number, p2: number): Side | null {
    const t = pick.toUpperCase().trim();
    if (t === '1' || t.includes('HOME')) return 'home';
    if (t === '2' || t.includes('AWAY')) return 'away';
    if (t === 'X' || t.includes('DRAW')) return 'draw';

    // If no explicit pick, use highest probability
    if (!isNaN(p1) && !isNaN(pX) && !isNaN(p2)) {
      const max = Math.max(p1, pX, p2);
      if (max === p1) return 'home';
      if (max === p2) return 'away';
      return 'draw';
    }
    return null;
  }

  private computeConfidence(
    modelConf: number, p1: number, pX: number, p2: number, side: Side,
  ): Confidence | null {
    // Prefer model confidence if available
    if (!isNaN(modelConf)) {
      if (modelConf >= 80) return 'best_bet';
      if (modelConf >= 65) return 'high';
      if (modelConf >= 50) return 'medium';
      return 'low';
    }

    // Fall back to probability
    if (isNaN(p1) || isNaN(pX) || isNaN(p2)) return null;
    let prob: number;
    if (side === 'home') prob = p1;
    else if (side === 'draw') prob = pX;
    else prob = p2;

    if (prob >= 70) return 'best_bet';
    if (prob >= 55) return 'high';
    if (prob >= 40) return 'medium';
    return 'low';
  }

  private parseDateTime(text: string, fetchedAt: Date): { gameDate: string; gameTime: string | null } {
    const dateMatch = text.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
    const timeMatch = text.match(/(\d{1,2}:\d{2})/);

    let gameDate = fetchedAt.toISOString().split('T')[0]!;
    if (dateMatch) {
      const day = dateMatch[1]!.padStart(2, '0');
      const month = dateMatch[2]!.padStart(2, '0');
      const year = dateMatch[3]
        ? (dateMatch[3].length === 2 ? `20${dateMatch[3]}` : dateMatch[3])
        : String(fetchedAt.getFullYear());
      gameDate = `${year}-${month}-${day}`;
    }

    return { gameDate, gameTime: timeMatch ? timeMatch[1]! : null };
  }
}
