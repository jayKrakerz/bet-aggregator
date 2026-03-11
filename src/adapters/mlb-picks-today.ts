import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * MLB Picks Today adapter.
 *
 * Scrapes daily MLB picks from mlbpickstoday.com.
 * A simple picks site with today's selections:
 *
 * - `.pick-card` or `.prediction-card` containers per game
 * - Team names in `.team-name` or `.matchup` elements
 * - Pick side indicated by `.selected`, `.pick`, or bold styling
 * - Confidence or star ratings in `.confidence`, `.stars`, or `.rating`
 * - Game time in `.game-time` or `.start-time`
 * - Analysis text in `.analysis` or `.write-up`
 */
export class MlbPicksTodayAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'mlb-picks-today',
    name: 'MLB Picks Today',
    baseUrl: 'https://www.mlbpickstoday.com',
    fetchMethod: 'http',
    paths: {
      mlb: '/',
    },
    cron: '0 0 9,13,17 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    $('.pick-card, .prediction-card, .game-pick, article.pick').each((_i, el) => {
      const $card = $(el);

      // Try multiple selectors for team names
      const matchupText = $card.find('.matchup, .teams, h2, h3').first().text().trim();
      const teams = this.extractTeams(matchupText);
      if (!teams) return;

      const { home, away } = teams;

      // Find the pick/selected team
      const pickText = $card.find('.pick, .selected, .best-bet, strong').first().text().trim();
      const side = this.resolveSide(pickText, home, away);

      // Game time
      const gameTime = $card.find('.game-time, .start-time, .time').text().trim() || null;

      // Confidence
      const confText = $card.find('.confidence, .rating, .stars').text().trim();
      const confidence = this.inferConfidence(confText);

      // Reasoning / analysis
      const reasoning = $card.find('.analysis, .write-up, .reasoning, p').first().text().trim().slice(0, 300) || null;

      // Pick type from card context
      const cardText = $card.text().toLowerCase();
      const pickType = this.inferPickType(cardText);

      // Value for spread/total picks
      let value: number | null = null;
      if (pickType === 'spread') {
        value = this.parseSpreadValue($card.find('.spread, .line').text());
      } else if (pickType === 'over_under') {
        value = this.parseTotalValue($card.find('.total, .ou-line').text());
      }

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: home,
        awayTeamRaw: away,
        gameDate: today,
        gameTime,
        pickType,
        side,
        value,
        pickerName: 'MLB Picks Today',
        confidence,
        reasoning,
        fetchedAt,
      });
    });

    return predictions;
  }

  private extractTeams(text: string): { home: string; away: string } | null {
    // "Away @ Home", "Away vs Home", "Away at Home", "Away vs. Home"
    const vsMatch = text.match(/^(.+?)\s+(?:@|vs\.?|at)\s+(.+?)$/i);
    if (vsMatch) {
      return { away: vsMatch[1]!.trim(), home: vsMatch[2]!.trim() };
    }
    return null;
  }

  private resolveSide(pick: string, home: string, away: string): Side {
    const pLower = pick.toLowerCase();
    if (pLower.includes('over')) return 'over';
    if (pLower.includes('under')) return 'under';
    const hLower = home.toLowerCase();
    const aLower = away.toLowerCase();
    if (pLower.includes(hLower) || hLower.includes(pLower)) return 'home';
    if (pLower.includes(aLower) || aLower.includes(pLower)) return 'away';
    return 'home';
  }
}
