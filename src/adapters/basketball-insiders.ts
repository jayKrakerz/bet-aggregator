import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Basketball Insiders adapter.
 *
 * STATUS: UNFIXABLE - /nba-picks-predictions/ returns 404 "Page not found"
 * as of 2026-03-10. The page no longer exists on basketballinsiders.org.
 * The site appears to be a general NBA news/rumors site without a dedicated
 * picks/predictions section. This adapter cannot produce predictions until
 * a valid URL is found.
 */
export class BasketballInsidersAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'basketball-insiders',
    name: 'Basketball Insiders',
    baseUrl: 'https://www.basketballinsiders.com',
    fetchMethod: 'http',
    paths: {
      nba: '/nba-picks-predictions/',
    },
    cron: '0 0 9,15 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    // Detect 404 / error pages early
    const title = $('title').text().toLowerCase();
    if (title.includes('not found') || title.includes('404') || $('body').hasClass('error404')) {
      return predictions;
    }

    // Try structured prediction items
    $('.game-pick, .prediction-item, .pick-card').each((_i, el) => {
      const $item = $(el);

      const matchupText = $item.find('.matchup, .game-title, h3, h4').text().trim();
      const teams = this.parseMatchup(matchupText);
      if (!teams) return;

      const pickText = $item.find('.pick, .prediction, .pick-value').text().trim();
      if (!pickText) return;

      const pickType = this.inferPickType(pickText);
      const side = this.resolveSide(pickText, teams.away, teams.home, pickType);
      const value = pickType === 'spread' ? this.parseSpreadValue(pickText)
        : pickType === 'over_under' ? this.parseTotalValue(pickText)
        : null;

      const authorName = $item.find('.author, .writer, .analyst').text().trim() || 'Basketball Insiders';

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: teams.home,
        awayTeamRaw: teams.away,
        gameDate: todayStr,
        gameTime: null,
        pickType,
        side,
        value,
        pickerName: authorName,
        confidence: null,
        reasoning: pickText.slice(0, 300) || null,
        fetchedAt,
      });
    });

    // Fallback: article-body parsing
    if (predictions.length === 0) {
      const content = $('.entry-content, .post-content, .article-body').first();
      const headings = content.find('h2, h3');

      headings.each((_i, el) => {
        const headingText = $(el).text().trim();
        const teams = this.parseMatchup(headingText);
        if (!teams) return;

        // Scan subsequent elements for picks
        let pickText = '';
        let reasoning = '';
        let next = $(el).next();
        for (let j = 0; j < 10 && next.length; j++) {
          if (next.is('h2, h3')) break;
          const text = next.text().trim();

          const pickMatch = text.match(/(?:pick|prediction|best bet|winner):\s*(.+?)(?:\.|$)/i);
          if (pickMatch) {
            pickText = pickMatch[1]!.trim();
            reasoning = text.slice(0, 300);
            break;
          }
          next = next.next();
        }

        if (!pickText) return;

        const pickType = this.inferPickType(pickText);
        const side = this.resolveSide(pickText, teams.away, teams.home, pickType);
        const value = pickType === 'spread' ? this.parseSpreadValue(pickText)
          : pickType === 'over_under' ? this.parseTotalValue(pickText)
          : null;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: teams.home,
          awayTeamRaw: teams.away,
          gameDate: todayStr,
          gameTime: null,
          pickType,
          side,
          value,
          pickerName: 'Basketball Insiders',
          confidence: null,
          reasoning: reasoning || pickText.slice(0, 300),
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  /** Parse "Team A vs Team B" or "Team A at Team B" matchup text. */
  private parseMatchup(text: string): { away: string; home: string } | null {
    const match = text.match(/^(.+?)\s+(?:vs\.?|@|at)\s+(.+?)(?:\s*[-–—(]|$)/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
  }

  private resolveSide(text: string, away: string, home: string, pickType: string): Side {
    const lower = text.toLowerCase();
    if (pickType === 'over_under') {
      return lower.includes('under') ? 'under' : 'over';
    }
    const awayLast = away.toLowerCase().split(' ').pop()!;
    const homeLast = home.toLowerCase().split(' ').pop()!;
    if (lower.includes(awayLast)) return 'away';
    if (lower.includes(homeLast)) return 'home';
    return 'home';
  }
}
