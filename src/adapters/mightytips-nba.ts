import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * MightyTips NBA adapter.
 *
 * STATUS: UNFIXABLE - /nba-predictions/ returns 404 "page not found" as of
 * 2026-03-10. MightyTips has removed all non-football sports prediction pages.
 * The site navigation only links to football (soccer) predictions now.
 * This adapter cannot produce predictions until a valid URL is found.
 */
export class MightytipsNbaAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'mightytips-nba',
    name: 'MightyTips NBA',
    baseUrl: 'https://www.mightytips.com',
    fetchMethod: 'http',
    paths: {
      nba: '/nba-predictions/',
    },
    cron: '0 0 8,14,20 * * *',
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
    if (title.includes('cannot be found') || title.includes('not found') || title.includes('404')) {
      return predictions;
    }

    $('.prediction-card, .tip-card, .tips-item, .bet-card').each((_i, el) => {
      const $card = $(el);

      // Extract teams
      const teamEls = $card.find('.match-teams .team, .team-name, .match__team');
      let awayTeamRaw = '';
      let homeTeamRaw = '';

      if (teamEls.length >= 2) {
        awayTeamRaw = $(teamEls[0]).text().trim();
        homeTeamRaw = $(teamEls[1]).text().trim();
      } else {
        // Try matchup header
        const matchupText = $card.find('.match-title, .event-name, .matchup').text().trim();
        const vsMatch = matchupText.match(/^(.+?)\s+(?:vs\.?|[-–])\s+(.+?)$/i);
        if (vsMatch) {
          awayTeamRaw = vsMatch[1]!.trim();
          homeTeamRaw = vsMatch[2]!.trim();
        }
      }
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Date
      const dateText = $card.find('.match-date, .event-date, .tip-date').text().trim();
      const gameDate = this.extractDate(dateText) || todayStr;

      // Pick
      const pickText = $card.find('.tip-pick, .prediction-pick, .tip__pick, .bet-pick').text().trim();
      if (!pickText) return;

      const pickType = this.inferPickType(pickText);
      let side: Side;
      let value: number | null = null;

      if (pickType === 'over_under') {
        side = pickText.toLowerCase().includes('under') ? 'under' : 'over';
        value = this.parseTotalValue(pickText);
      } else if (pickType === 'spread') {
        value = this.parseSpreadValue(pickText);
        side = this.resolveTeamSide(pickText, awayTeamRaw, homeTeamRaw);
      } else {
        side = this.resolveTeamSide(pickText, awayTeamRaw, homeTeamRaw);
      }

      // Tipster and confidence
      const tipsterName = $card.find('.tipster-name, .author-name, .expert').text().trim() || 'MightyTips';
      const confText = $card.find('.confidence-level, .tip-rating, .stars').text().trim();
      const confidence = this.parseStarRating(confText);

      // Analysis text
      const analysis = $card.find('.tip-analysis, .prediction-text, .tip-reason').text().trim();

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate,
        gameTime: null,
        pickType,
        side,
        value,
        pickerName: tipsterName,
        confidence,
        reasoning: analysis ? analysis.slice(0, 300) : pickText.slice(0, 300),
        fetchedAt,
      });
    });

    return predictions;
  }

  private resolveTeamSide(text: string, away: string, home: string): Side {
    const lower = text.toLowerCase();
    const awayLast = away.toLowerCase().split(' ').pop()!;
    const homeLast = home.toLowerCase().split(' ').pop()!;
    if (lower.includes(awayLast)) return 'away';
    if (lower.includes(homeLast)) return 'home';
    return 'home';
  }

  /** Parse star ratings (e.g., "4/5", "3 stars", "★★★★"). */
  private parseStarRating(text: string): 'low' | 'medium' | 'high' | 'best_bet' | null {
    if (!text) return null;
    // Count star characters
    const stars = (text.match(/★|⭐/g) || []).length;
    if (stars > 0) {
      if (stars >= 5) return 'best_bet';
      if (stars >= 4) return 'high';
      if (stars >= 3) return 'medium';
      return 'low';
    }
    // Try numeric rating
    const numMatch = text.match(/(\d)(?:\s*\/\s*\d)?/);
    if (numMatch) {
      const num = parseInt(numMatch[1]!, 10);
      if (num >= 5) return 'best_bet';
      if (num >= 4) return 'high';
      if (num >= 3) return 'medium';
      return 'low';
    }
    return this.inferConfidence(text);
  }

  private extractDate(text: string): string | null {
    // Try MM/DD format
    const slashMatch = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (slashMatch) {
      const month = slashMatch[1]!.padStart(2, '0');
      const day = slashMatch[2]!.padStart(2, '0');
      const year = slashMatch[3] ? (slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3]) : String(new Date().getFullYear());
      return `${year}-${month}-${day}`;
    }
    // Try "DD Month YYYY" or "Month DD, YYYY"
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const mdMatch = text.match(/(\d{1,2})\s+([A-Za-z]{3,})/);
    if (mdMatch) {
      const day = mdMatch[1]!.padStart(2, '0');
      const mon = months[mdMatch[2]!.toLowerCase().slice(0, 3)];
      if (mon) return `${new Date().getFullYear()}-${mon}-${day}`;
    }
    return null;
  }
}
