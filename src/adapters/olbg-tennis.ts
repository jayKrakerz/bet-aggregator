import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * OLBG Tennis adapter (olbg.com/tennis).
 *
 * Server-rendered site with community betting tips. Tips are displayed
 * in a card/list layout with tipster info and success rates.
 *
 * Expected page structure:
 *   - Tip containers: `.tip-card`, `.bet-tip`, `.tipster-tip`, `[class*="tip-row"]`
 *   - Match/event: `.event-name`, `.match`, `h3, h4` with "Player1 v Player2"
 *   - Tipster: `.tipster-name`, `.user-name`, `[class*="tipster"]`
 *   - Selection: `.selection`, `.tip-selection`, `.pick` with the chosen outcome
 *   - Odds: `.odds`, `.tip-odds` with decimal or fractional odds
 *   - Stats: `.tipster-stats`, `.success-rate` with win percentage
 *   - Date: `.event-date`, `.tip-date`
 *   - Tips may be grouped by match event
 */
export class OlbgTennisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'olbg-tennis',
    name: 'OLBG Tennis',
    baseUrl: 'https://www.olbg.com',
    fetchMethod: 'http',
    paths: {
      tennis: '/betting-tips/tennis/',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Primary selector: tip cards/rows
    $('.tip-card, .bet-tip, .tipster-tip, [class*="tip-row"], .tip-item, .tips-row').each((_i, el) => {
      const $tip = $(el);

      // Extract match/event name
      const eventText = $tip.find('.event-name, .match, h3, h4, .fixture, [class*="event"]').first().text().trim();
      const { player1, player2 } = this.extractPlayers(eventText);
      if (!player1 || !player2) return;

      // Extract selection
      const selection = $tip.find('.selection, .tip-selection, .pick, [class*="selection"]').first().text().trim();
      const side = this.resolveSide(selection, player1, player2);

      // Extract tipster name
      const tipster = $tip.find('.tipster-name, .user-name, [class*="tipster"], [class*="username"]')
        .first().text().trim();

      // Extract odds (may be decimal or fractional)
      const oddsText = $tip.find('.odds, .tip-odds, [class*="odds"]').first().text().trim();
      const value = this.parseOdds(oddsText);

      // Extract success rate for confidence
      const rateText = $tip.find('.success-rate, .tipster-stats, [class*="rate"], [class*="profit"]')
        .text().trim();
      const confidence = this.rateToConfidence(rateText);

      // Extract date
      const dateText = $tip.find('.event-date, .tip-date, .date, [class*="date"]').first().text().trim();
      const gameDate = this.parseDateText(dateText, fetchedAt);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate,
        gameTime: null,
        pickType: 'moneyline',
        side,
        value,
        pickerName: tipster || 'OLBG Tipster',
        confidence,
        reasoning: selection ? `Tip: ${selection}` : null,
        fetchedAt,
      });
    });

    // Fallback: event-grouped tips
    if (predictions.length === 0) {
      $('.event-group, .match-group, [class*="eventGroup"]').each((_i, el) => {
        const $group = $(el);
        const eventTitle = $group.find('h2, h3, .event-title, .match-title').first().text().trim();
        const { player1, player2 } = this.extractPlayers(eventTitle);
        if (!player1 || !player2) return;

        $group.find('.tip, .user-tip, .community-tip').each((_j, tipEl) => {
          const $tip = $(tipEl);
          const selection = $tip.find('.selection, .pick').text().trim();
          const side = this.resolveSide(selection, player1, player2);
          const tipster = $tip.find('.tipster-name, .user-name').text().trim();

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
            pickerName: tipster || 'OLBG Tipster',
            confidence: null,
            reasoning: selection ? `Tip: ${selection}` : null,
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

  private parseOdds(text: string): number | null {
    // Decimal odds: "1.85"
    const decMatch = text.match(/(\d+\.\d+)/);
    if (decMatch) return parseFloat(decMatch[1]!);

    // Fractional odds: "5/4" → convert to decimal
    const fracMatch = text.match(/(\d+)\/(\d+)/);
    if (fracMatch) {
      const num = parseInt(fracMatch[1]!, 10);
      const den = parseInt(fracMatch[2]!, 10);
      if (den > 0) return Math.round(((num / den) + 1) * 100) / 100;
    }

    return null;
  }

  private rateToConfidence(text: string): RawPrediction['confidence'] {
    const match = text.match(/(\d{1,3})%/);
    if (!match) return null;
    const rate = parseInt(match[1]!, 10);
    if (rate >= 65) return 'best_bet';
    if (rate >= 50) return 'high';
    if (rate >= 35) return 'medium';
    return 'low';
  }

  private parseDateText(text: string, fetchedAt: Date): string {
    if (!text || text.toLowerCase().includes('today')) return fetchedAt.toISOString().split('T')[0]!;

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
