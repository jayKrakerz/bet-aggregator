import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * MyBetting Tennis adapter (mybetting.com/tennis-tips).
 *
 * STATUS: URL returns empty HTML response with no prediction content.
 * The site may have changed structure or the path is incorrect.
 *
 * Server-rendered site with daily tennis tips organized by tournament.
 *
 * Expected page structure:
 *   - Tip sections: `.tip-section`, `.match-tip`, `article.tip`
 *   - Match heading: `h2, h3` with "Player1 vs Player2"
 *   - Tournament: `.tournament-name`, `.event`, `.competition`
 *   - Tip/selection: `.tip-selection`, `.bet-selection`, `.pick`
 *   - Odds: `.odds`, `.tip-odds`
 *   - Analysis: `.tip-text`, `.analysis`, `.content p`
 *   - Best bet marker: `.best-bet`, `.top-tip`, `.nap`
 *   - Date: header or `.date` element
 */
export class MyBettingTennisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'mybetting-tennis',
    name: 'MyBetting Tennis',
    baseUrl: 'https://www.mybetting.com',
    fetchMethod: 'http',
    paths: {
      tennis: '/tennis-tips/',
    },
    cron: '0 0 6,12 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Try structured tip sections
    $('.tip-section, .match-tip, article.tip, .tip-card, .betting-tip, .prediction-card').each((_i, el) => {
      const $tip = $(el);

      // Extract match players from heading
      const heading = $tip.find('h2, h3, h4, .match-title, .fixture').first().text().trim();
      const { player1, player2 } = this.extractPlayers(heading);
      if (!player1 || !player2) return;

      // Extract selection/pick
      const selection = $tip.find('.tip-selection, .bet-selection, .pick, .selection, strong')
        .first().text().trim();
      const side = this.resolveSide(selection, player1, player2);
      const pickType = this.inferPickType(selection);

      // Extract value for over/under picks
      let value: number | null = null;
      if (pickType === 'over_under') {
        value = this.parseTotalValue(selection);
      }

      // Extract odds
      if (value === null) {
        const oddsText = $tip.find('.odds, .tip-odds, .price, [class*="odds"]').first().text().trim();
        const odds = parseFloat(oddsText.replace(/[^0-9.]/g, ''));
        if (!isNaN(odds) && odds > 1) value = odds;
      }

      // Extract analysis text
      const analysis = $tip.find('.tip-text, .analysis, .content p, .reasoning, .description')
        .first().text().trim();

      // Check for best bet marker
      const isBestBet = $tip.find('.best-bet, .top-tip, .nap, [class*="bestBet"]').length > 0
        || $tip.hasClass('best-bet') || $tip.hasClass('top-tip');

      // Extract tournament
      const tournament = $tip.find('.tournament-name, .event, .competition, [class*="tournament"]')
        .first().text().trim();

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate: fetchedAt.toISOString().split('T')[0]!,
        gameTime: null,
        pickType,
        side,
        value,
        pickerName: 'MyBetting',
        confidence: isBestBet ? 'best_bet' : null,
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
}
