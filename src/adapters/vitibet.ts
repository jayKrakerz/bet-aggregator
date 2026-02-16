import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Vitibet adapter.
 *
 * Static HTML site with football predictions in `.quicktipsmainpage2` containers.
 *
 * Page structure:
 *   - `.quicktipsmainpage2` — prediction container for each match
 *   - Teams: two `<a>` links inside the container (home vs away)
 *   - Prediction: `<b>` tag with "1", "X", or "2" (home/draw/away)
 *   - Odds: three `<td>` cells with decimal odds (home, draw, away)
 *   - Date: header rows with date text (DD.MM.YYYY)
 *   - Score prediction: shown as "X:Y" in the container
 */
export class VitibetAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'vitibet',
    name: 'Vitibet',
    baseUrl: 'https://www.vitibet.com',
    fetchMethod: 'http',
    paths: { football: '/soccer.php' },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentDate = fetchedAt.toISOString().split('T')[0]!;

    // Date headers contain the match date
    $('table.main tr, .quicktipsmainpage2').each((_i, el) => {
      const $el = $(el);

      // Check for date header rows
      const dateText = $el.find('td.pointed2').text().trim() || $el.find('.pointed2').text().trim();
      if (dateText) {
        const dateMatch = dateText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (dateMatch) {
          const day = dateMatch[1]!.padStart(2, '0');
          const month = dateMatch[2]!.padStart(2, '0');
          const year = dateMatch[3]!;
          currentDate = `${year}-${month}-${day}`;
          return;
        }
      }

      // Prediction rows — look for team links and prediction indicator
      const links = $el.find('a');
      if (links.length < 2) return;

      const homeTeamRaw = $(links[0]).text().trim();
      const awayTeamRaw = $(links[1]).text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Extract the 1X2 prediction
      const predBold = $el.find('b').first().text().trim();
      const side = this.mapPredictionSide(predBold);
      if (!side) return;

      // Extract odds from table cells
      const oddsCells = $el.find('td.pointed');
      const odds: number[] = [];
      oddsCells.each((_j, cell) => {
        const val = parseFloat($(cell).text().trim());
        if (!isNaN(val) && val > 1) odds.push(val);
      });

      // Pick the relevant odds value
      let value: number | null = null;
      if (side === 'home' && odds[0]) value = odds[0];
      else if (side === 'draw' && odds[1]) value = odds[1];
      else if (side === 'away' && odds[2]) value = odds[2];

      // Extract score prediction for reasoning
      const scoreText = $el.find('td').filter((_j, td) => {
        const t = $(td).text().trim();
        return /^\d+:\d+$/.test(t);
      }).first().text().trim();

      const reasoning = scoreText ? `Predicted score: ${scoreText}` : null;

      // Extract time if available
      const timeMatch = $el.text().match(/(\d{1,2}:\d{2})/);
      const gameTime = timeMatch ? timeMatch[1]! : null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate: currentDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value,
        pickerName: 'Vitibet',
        confidence: this.mapOddsToConfidence(value),
        reasoning,
        fetchedAt,
      });
    });

    return predictions;
  }

  private mapPredictionSide(pred: string): Side | null {
    if (pred === '1') return 'home';
    if (pred === 'X' || pred === 'x') return 'draw';
    if (pred === '2') return 'away';
    return null;
  }

  private mapOddsToConfidence(odds: number | null): Confidence | null {
    if (!odds) return null;
    // Lower odds = higher confidence (implied probability)
    if (odds <= 1.3) return 'best_bet';
    if (odds <= 1.7) return 'high';
    if (odds <= 2.5) return 'medium';
    return 'low';
  }
}
