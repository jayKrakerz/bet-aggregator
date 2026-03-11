import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * BettingExpert Tennis adapter (bettingexpert.com/tennis).
 *
 * STATUS: UNFIXABLE - As of 2026-03-10, the /tennis/tips/ page returns
 * "The page you requested was not found" in the main content area.
 * The site uses web components from igaming-sport-service.io loaded via
 * `<script type="module">` which render tip content in shadow DOM that
 * cheerio cannot access. Even when the page works, tip data would be
 * inside shadow DOM custom elements.
 *
 * The page is a Next.js app (no __NEXT_DATA__ in snapshot) that loads
 * sport-webcomponents.esm.js for tip card rendering. The main content
 * shows a 404 message when tips aren't available.
 */
export class BettingExpertTennisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'betting-expert-tennis',
    name: 'Betting Expert Tennis',
    baseUrl: 'https://www.bettingexpert.com',
    fetchMethod: 'browser',
    paths: {
      tennis: '/tennis/tips/',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 6000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('.tip-card, [class*="TipCard"], [class*="tipCard"]', {
      timeout: 15000,
    }).catch(() => {});
    await page.waitForTimeout(3000);
    // Scroll to load more tips
    for (let i = 0; i < 3; i++) {
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await page.waitForTimeout(1500);
    }
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('.tip-card, [class*="TipCard"], [class*="tipCard"], .tip-item').each((_i, el) => {
      const $card = $(el);

      // Extract match info: "Player1 v Player2" or "Player1 vs Player2"
      const matchText = $card.find('.tip-card__match, .match-info, [class*="match"], [class*="Match"]')
        .first().text().trim();
      const { player1, player2 } = this.extractPlayers(matchText);
      if (!player1 || !player2) return;

      // Extract pick/outcome text
      const pickText = $card.find('.tip-card__pick, .pick-text, [class*="pick"], [class*="Pick"], [class*="outcome"]')
        .first().text().trim();
      const side = this.resolveSide(pickText, player1, player2);

      // Extract tipster name
      const tipster = $card.find('.tipster-name, [class*="tipster"], [class*="Tipster"], [class*="author"]')
        .first().text().trim();

      // Extract odds
      const oddsText = $card.find('.tip-card__odds, .odds, [class*="odds"], [class*="Odds"]')
        .first().text().trim();
      const odds = parseFloat(oddsText.replace(/[^0-9.+-]/g, ''));
      const value = !isNaN(odds) ? odds : null;

      // Extract date
      const dateText = $card.find('.tip-card__date, .match-date, [class*="date"], [class*="Date"]')
        .first().text().trim();
      const gameDate = this.parseDateText(dateText, fetchedAt);

      // Extract confidence from success rate
      const rateText = $card.find('.success-rate, [class*="rate"], [class*="profit"], [class*="yield"]')
        .text().trim();
      const confidence = this.parseRateConfidence(rateText);

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
        pickerName: tipster || 'BettingExpert Tipster',
        confidence,
        reasoning: pickText ? pickText.slice(0, 300) : null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private extractPlayers(text: string): { player1: string; player2: string } {
    const cleaned = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    const vsMatch = cleaned.match(/(.+?)\s+(?:vs?\.?|[-])\s+(.+?)(?:\s*$|\s*\(|\s*,)/i);
    if (vsMatch) {
      return { player1: vsMatch[1]!.trim(), player2: vsMatch[2]!.trim() };
    }
    return { player1: '', player2: '' };
  }

  private resolveSide(pickText: string, player1: string, player2: string): Side {
    const lower = pickText.toLowerCase();
    const p1Last = player1.toLowerCase().split(' ').pop() || '';
    const p2Last = player2.toLowerCase().split(' ').pop() || '';

    if (lower.includes('over')) return 'over';
    if (lower.includes('under')) return 'under';
    if (p1Last.length > 2 && lower.includes(p1Last)) return 'home';
    if (p2Last.length > 2 && lower.includes(p2Last)) return 'away';
    if (lower.includes('to win') || lower.includes('winner')) {
      // First mentioned player is usually the pick
      return 'home';
    }
    return 'home';
  }

  private parseDateText(text: string, fetchedAt: Date): string {
    if (text.toLowerCase().includes('today')) return fetchedAt.toISOString().split('T')[0]!;
    if (text.toLowerCase().includes('tomorrow')) {
      const d = new Date(fetchedAt);
      d.setDate(d.getDate() + 1);
      return d.toISOString().split('T')[0]!;
    }

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

  private parseRateConfidence(text: string): RawPrediction['confidence'] {
    const match = text.match(/(\d{1,3})%/);
    if (!match) return null;
    const rate = parseInt(match[1]!, 10);
    if (rate >= 70) return 'best_bet';
    if (rate >= 55) return 'high';
    if (rate >= 40) return 'medium';
    return 'low';
  }
}
