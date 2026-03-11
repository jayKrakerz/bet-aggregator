import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * ProSportsTips Tennis adapter (prosportstips.com/tennis).
 *
 * Server-rendered site with free tennis tips organized by date.
 *
 * Expected page structure:
 *   - Tip containers: `.tip`, `.tip-card`, `.match-tip`, `article.post`
 *   - Match heading: `h2, h3` with "Player1 vs Player2"
 *   - Tournament: `.tournament`, `.competition`, `.event`
 *   - Tip text: `.tip-content`, `.tip-text`, `.selection` with "Player1 to win"
 *   - Odds: `.odds`, `.tip-odds`, `.price`
 *   - Confidence: `.confidence`, `.rating`, `.stars`
 *   - Date: `.date`, `.tip-date`, `time`
 *   - Analysis: `.analysis`, `.reasoning`, `.content p`
 */
export class ProSportsTipsTennisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'prosportstips-tennis',
    name: 'ProSportsTips Tennis',
    baseUrl: 'https://www.prosportstips.com',
    fetchMethod: 'http',
    paths: {
      tennis: '/tennis/',
    },
    cron: '0 0 7,13 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Try structured tip containers
    $('.tip, .tip-card, .match-tip, .prediction-card, .tip-item, .bet-tip').each((_i, el) => {
      const $tip = $(el);

      const heading = $tip.find('h2, h3, h4, .match-title, .fixture, .match-name').first().text().trim();
      const { player1, player2 } = this.extractPlayers(heading);
      if (!player1 || !player2) return;

      // Extract tip/selection
      const tipText = $tip.find('.tip-content, .tip-text, .selection, .pick, .tip-pick, strong')
        .first().text().trim();
      const side = this.resolveSide(tipText, player1, player2);
      const pickType = this.inferPickType(tipText);

      // Extract value
      let value: number | null = null;
      if (pickType === 'over_under') {
        value = this.parseTotalValue(tipText);
      }

      // Extract odds
      if (value === null) {
        const oddsText = $tip.find('.odds, .tip-odds, .price, [class*="odds"]').first().text().trim();
        const odds = parseFloat(oddsText.replace(/[^0-9.]/g, ''));
        if (!isNaN(odds) && odds > 1) value = odds;
      }

      // Extract confidence
      const confText = $tip.find('.confidence, .rating, .stars, [class*="confidence"]').text().trim();
      const confidence = this.parseConfidence(confText);

      // Extract analysis
      const analysis = $tip.find('.analysis, .reasoning, .content p, .description').first().text().trim();

      // Extract tournament
      const tournament = $tip.find('.tournament, .competition, .event, [class*="tournament"]')
        .first().text().trim();

      // Extract date
      const dateText = $tip.find('.date, .tip-date, time, [class*="date"]').first().text().trim();
      const gameDate = this.parseDateText(dateText, fetchedAt);

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
        pickerName: 'ProSportsTips',
        confidence,
        reasoning: [tournament, analysis].filter(Boolean).join(' | ').slice(0, 500) || null,
        fetchedAt,
      });
    });

    // Fallback: blog-style posts
    if (predictions.length === 0) {
      $('article.post, .entry-content, .post-content').each((_i, el) => {
        const $post = $(el);
        $post.find('h2, h3').each((_j, heading) => {
          const headText = $(heading).text().trim();
          const { player1, player2 } = this.extractPlayers(headText);
          if (!player1 || !player2) return;

          const nextP = $(heading).next('p').text().trim();
          const side = this.resolveSide(nextP, player1, player2);

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
            pickerName: 'ProSportsTips',
            confidence: null,
            reasoning: nextP ? nextP.slice(0, 500) : null,
            fetchedAt,
          });
        });
      });
    }

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
    const pctMatch = text.match(/(\d{1,3})%/);
    if (pctMatch) {
      const pct = parseInt(pctMatch[1]!, 10);
      if (pct >= 80) return 'best_bet';
      if (pct >= 65) return 'high';
      if (pct >= 50) return 'medium';
      return 'low';
    }

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
