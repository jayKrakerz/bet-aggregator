import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * TennisTips UK adapter (tennistips.co.uk).
 *
 * Static HTML site with daily tennis tips presented as blog-style posts
 * or structured tip cards.
 *
 * Expected page structure:
 *   - Tip containers: `.tip-card`, `.betting-tip`, `article.tip`, `.tips-list .tip`
 *   - Match: "Player1 vs Player2" in heading or `.match-name`
 *   - Tournament: `.tournament`, `.event-name`
 *   - Pick: `.tip-selection`, `.pick` with "Player1 to win" or "Over 22.5 games"
 *   - Odds: `.odds`, `.tip-odds` with decimal odds
 *   - Tipster reasoning: `.tip-analysis`, `.reasoning`, `p` after the tip heading
 *   - Date: `.tip-date`, published date in article meta
 */
export class TennisTipsUkAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'tennis-tips-uk',
    name: 'Tennis Tips UK',
    baseUrl: 'https://www.tennistips.co.uk',
    fetchMethod: 'http',
    paths: {
      tennis: '/tips/today/',
    },
    cron: '0 0 7,13 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Try structured tip cards first
    $('.tip-card, .betting-tip, article.tip, .tips-list .tip, .tip-container, .match-tip').each((_i, el) => {
      const $tip = $(el);

      // Extract match/players
      const matchText = $tip.find('h2, h3, .match-name, .match, .fixture').first().text().trim();
      const { player1, player2 } = this.extractPlayers(matchText);
      if (!player1 || !player2) return;

      // Extract pick
      const pickText = $tip.find('.tip-selection, .pick, .selection, .tip-pick, strong').first().text().trim();
      const side = this.resolveSide(pickText, player1, player2);
      const pickType = this.inferPickType(pickText);

      // Extract odds
      const oddsText = $tip.find('.odds, .tip-odds, .price').first().text().trim();
      const odds = parseFloat(oddsText.replace(/[^0-9.]/g, ''));
      const value = !isNaN(odds) ? odds : null;

      // Extract reasoning
      const analysis = $tip.find('.tip-analysis, .reasoning, .analysis, .description').first().text().trim();

      // Extract tournament
      const tournament = $tip.find('.tournament, .event-name, .competition').first().text().trim();

      // Extract date
      const dateText = $tip.find('.tip-date, .date, time').first().text().trim();
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
        pickerName: 'Tennis Tips UK',
        confidence: null,
        reasoning: [tournament, analysis].filter(Boolean).join(' | ').slice(0, 500) || null,
        fetchedAt,
      });
    });

    // Fallback: look for tips in article/post content
    if (predictions.length === 0) {
      $('article, .post, .entry-content').each((_i, el) => {
        const $article = $(el);
        // Look for "Player1 vs Player2" patterns in headings
        $article.find('h2, h3, h4').each((_j, heading) => {
          const headText = $(heading).text().trim();
          const { player1, player2 } = this.extractPlayers(headText);
          if (!player1 || !player2) return;

          // Get the paragraph after the heading as the tip text
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
            pickerName: 'Tennis Tips UK',
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
    const vsMatch = cleaned.match(/([A-Z][a-zA-Z.\-' ]+?)\s+(?:vs\.?|v\.?|[-])\s+([A-Z][a-zA-Z.\-' ]+?)(?:\s*$|\s*[,(])/);
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

    const longMatch = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s*(\d{4})?/i);
    if (longMatch) {
      const months: Record<string, string> = {
        jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
        jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
      };
      const day = longMatch[1]!.padStart(2, '0');
      const month = months[longMatch[2]!.toLowerCase().slice(0, 3)] || '01';
      const year = longMatch[3] || fetchedAt.getFullYear().toString();
      return `${year}-${month}-${day}`;
    }

    return fetchedAt.toISOString().split('T')[0]!;
  }
}
