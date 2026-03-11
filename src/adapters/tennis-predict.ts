import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * TennisPredict adapter (tennispredict.com).
 *
 * STATUS: UNFIXABLE - /predictions/ returns 404 "Page not found" as of
 * 2026-03-10. TennisPredict.com appears to be a tennis articles/gear review
 * site (not a prediction service). The navigation shows Articles, Tennis Gear,
 * Tennis School, and About Us -- no predictions section. This adapter cannot
 * produce predictions.
 */
export class TennisPredictAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'tennis-predict',
    name: 'Tennis Predict',
    baseUrl: 'https://www.tennispredict.com',
    fetchMethod: 'http',
    paths: {
      tennis: '/predictions/',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Detect 404 / error pages early
    const title = $('title').text().toLowerCase();
    if (title.includes('not found') || title.includes('404') || $('body').hasClass('error404')) {
      return predictions;
    }

    // Try table-based layout first
    $('table.predictions tbody tr, table.pred-table tbody tr, .prediction-table tr').each((_i, el) => {
      const $row = $(el);
      const cells = $row.find('td');
      if (cells.length < 3) return;

      const { player1, player2 } = this.extractPlayers($row.text());
      if (!player1 || !player2) return;

      // Look for prediction indicator (highlighted, bold, or marked cell)
      const predCell = $row.find('td.winner, td.predicted, td strong, td b').first().text().trim();
      const side = this.resolveSide(predCell, player1, player2);

      // Extract confidence from percentage text
      const probText = $row.find('td.prob, td.confidence, td.percentage').text().trim();
      const confidence = this.parseConfidenceFromPercent(probText);

      // Extract date
      const dateText = $row.find('td.date, td:first-child').first().text().trim();
      const gameDate = this.parseDateText(dateText, fetchedAt);
      const gameTime = this.parseTimeText(dateText);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'TennisPredict',
        confidence,
        reasoning: null,
        fetchedAt,
      });
    });

    // Fallback: card-based layout
    if (predictions.length === 0) {
      $('.match-prediction, .prediction-card, .match-row, .prediction-row').each((_i, el) => {
        const $card = $(el);
        const text = $card.text();

        const { player1, player2 } = this.extractPlayers(text);
        if (!player1 || !player2) return;

        const predText = $card.find('.prediction, .pick, .winner, .tip, strong').first().text().trim();
        const side = this.resolveSide(predText, player1, player2);

        const probText = $card.find('.probability, .confidence, .percent').text().trim();
        const confidence = this.parseConfidenceFromPercent(probText);

        const analysis = $card.find('.analysis, .reasoning, .description, p').first().text().trim();

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: player1,
          awayTeamRaw: player2,
          gameDate: fetchedAt.toISOString().split('T')[0]!,
          gameTime: null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'TennisPredict',
          confidence,
          reasoning: analysis ? analysis.slice(0, 500) : null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  /** Extract two player names from text containing "vs", "v", or "-" separator. */
  private extractPlayers(text: string): { player1: string; player2: string } {
    const cleaned = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    const vsMatch = cleaned.match(/([A-Z][a-zA-Z.\-' ]+?)\s+(?:vs\.?|v\.?|[-])\s+([A-Z][a-zA-Z.\-' ]+?)(?:\s|$|,|\()/);
    if (vsMatch) {
      return { player1: vsMatch[1]!.trim(), player2: vsMatch[2]!.trim() };
    }
    return { player1: '', player2: '' };
  }

  private resolveSide(predText: string, player1: string, player2: string): Side {
    const lower = predText.toLowerCase();
    const p1Lower = player1.toLowerCase();
    const p2Lower = player2.toLowerCase();
    const p1Last = p1Lower.split(' ').pop() || '';
    const p2Last = p2Lower.split(' ').pop() || '';

    if (lower.includes(p1Last) && p1Last.length > 2) return 'home';
    if (lower.includes(p2Last) && p2Last.length > 2) return 'away';
    return 'home';
  }

  private parseConfidenceFromPercent(text: string): RawPrediction['confidence'] {
    const match = text.match(/(\d{1,3})%?/);
    if (!match) return null;
    const pct = parseInt(match[1]!, 10);
    if (pct >= 80) return 'best_bet';
    if (pct >= 65) return 'high';
    if (pct >= 50) return 'medium';
    return 'low';
  }

  private parseDateText(text: string, fetchedAt: Date): string {
    // Try DD/MM/YYYY or DD.MM.YYYY or YYYY-MM-DD
    const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

    const euroMatch = text.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
    if (euroMatch) {
      const day = euroMatch[1]!.padStart(2, '0');
      const month = euroMatch[2]!.padStart(2, '0');
      const year = euroMatch[3]!.length === 2 ? `20${euroMatch[3]}` : euroMatch[3];
      return `${year}-${month}-${day}`;
    }

    return fetchedAt.toISOString().split('T')[0]!;
  }

  private parseTimeText(text: string): string | null {
    const timeMatch = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!timeMatch) return null;
    return timeMatch[0].trim();
  }
}
