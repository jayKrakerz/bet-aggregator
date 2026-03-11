import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * MightyTips Tennis adapter (mightytips.com/tennis-predictions).
 *
 * STATUS: UNFIXABLE - /tennis-predictions/ returns 404 "page not found" as of
 * 2026-03-10. MightyTips has removed all non-football sports prediction pages.
 * The site navigation only links to football (soccer) predictions now.
 * This adapter cannot produce predictions until a valid URL is found.
 */
export class MightyTipsTennisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'mightytips-tennis',
    name: 'MightyTips Tennis',
    baseUrl: 'https://www.mightytips.com',
    fetchMethod: 'http',
    paths: {
      tennis: '/tennis-predictions/',
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
    if (title.includes('cannot be found') || title.includes('not found') || title.includes('404')) {
      return predictions;
    }

    $('.prediction-card, .match-prediction, article.prediction, .tip-card, .prediction-item, .prediction-row').each((_i, el) => {
      const $card = $(el);

      // Extract match/players
      const heading = $card.find('h2, h3, h4, .match-title, .fixture, [class*="match-name"]')
        .first().text().trim();
      const { player1, player2 } = this.extractPlayers(heading);
      if (!player1 || !player2) return;

      // Extract prediction text
      const predText = $card.find('.prediction-text, .tip, .pick, .selection, [class*="prediction"]')
        .first().text().trim();
      const side = this.resolveSide(predText, player1, player2);
      const pickType = this.inferPickType(predText);

      // Extract value
      let value: number | null = null;
      if (pickType === 'over_under') {
        value = this.parseTotalValue(predText);
      }

      // Extract odds
      if (value === null) {
        const oddsText = $card.find('.odds, .prediction-odds, [class*="odds"]').first().text().trim();
        const odds = parseFloat(oddsText.replace(/[^0-9.]/g, ''));
        if (!isNaN(odds) && odds > 1) value = odds;
      }

      // Extract expert name
      const expert = $card.find('.expert-name, .tipster, .author-name, [class*="author"], [class*="expert"]')
        .first().text().trim();

      // Extract analysis
      const analysis = $card.find('.analysis, .prediction-content, .reasoning, .description, p')
        .first().text().trim();

      // Extract confidence
      const confText = $card.find('.confidence-rating, .stars, .probability, [class*="confidence"], [class*="rating"]')
        .text().trim();
      const confidence = this.parseConfidence(confText);

      // Extract date
      const dateEl = $card.find('time[datetime]');
      let gameDate = fetchedAt.toISOString().split('T')[0]!;
      if (dateEl.length) {
        const dt = dateEl.attr('datetime');
        if (dt) {
          const isoMatch = dt.match(/(\d{4})-(\d{2})-(\d{2})/);
          if (isoMatch) gameDate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
        }
      } else {
        const dateText = $card.find('.match-date, .event-date, .date, [class*="date"]').first().text().trim();
        gameDate = this.parseDateText(dateText, fetchedAt);
      }

      // Extract tournament
      const tournament = $card.find('.tournament, .event-info, .competition, [class*="tournament"]')
        .first().text().trim();

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate,
        gameTime: null,
        pickType,
        side,
        value,
        pickerName: expert || 'MightyTips Expert',
        confidence,
        reasoning: [tournament, analysis].filter(Boolean).join(' | ').slice(0, 500) || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private extractPlayers(text: string): { player1: string; player2: string } {
    const cleaned = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    const vsMatch = cleaned.match(/([A-Z][a-zA-Z.\-' ]+?)\s+(?:vs?\.?|[-])\s+([A-Z][a-zA-Z.\-' ]+?)(?:\s*$|\s*[,(])/i);
    if (vsMatch) {
      return { player1: vsMatch[1]!.trim(), player2: vsMatch[2]!.trim() };
    }
    return { player1: '', player2: '' };
  }

  private resolveSide(text: string, player1: string, player2: string): Side {
    const lower = text.toLowerCase();
    const p1Last = player1.toLowerCase().split(' ').pop() || '';
    const p2Last = player2.toLowerCase().split(' ').pop() || '';

    if (lower.includes('over')) return 'over';
    if (lower.includes('under')) return 'under';
    if (p1Last.length > 2 && lower.includes(p1Last)) return 'home';
    if (p2Last.length > 2 && lower.includes(p2Last)) return 'away';
    return 'home';
  }

  private parseConfidence(text: string): RawPrediction['confidence'] {
    // Percentage-based
    const pctMatch = text.match(/(\d{1,3})%/);
    if (pctMatch) {
      const pct = parseInt(pctMatch[1]!, 10);
      if (pct >= 80) return 'best_bet';
      if (pct >= 65) return 'high';
      if (pct >= 50) return 'medium';
      return 'low';
    }

    // Star rating: "4/5" or count of star chars
    const starMatch = text.match(/(\d)\s*\/\s*5/);
    if (starMatch) {
      const stars = parseInt(starMatch[1]!, 10);
      if (stars >= 5) return 'best_bet';
      if (stars >= 4) return 'high';
      if (stars >= 3) return 'medium';
      return 'low';
    }

    return null;
  }

  private parseDateText(text: string, fetchedAt: Date): string {
    if (!text || text.toLowerCase().includes('today')) return fetchedAt.toISOString().split('T')[0]!;

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
}
