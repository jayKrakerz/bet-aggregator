import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Hashtag Basketball adapter.
 *
 * Scrapes NBA picks/predictions from hashtagbasketball.com.
 * The site publishes daily NBA picks with spread, moneyline, and totals.
 *
 * Expected structure:
 * - `.pick-card`, `.game-card`, `.prediction-row`, or `tr` rows in a picks table
 * - Team names in `.team-name`, `.team`, `td.team`, or matchup headers
 * - Pick side via `.selected`, `.pick`, or highlighted styling
 * - Spread/total values in `.spread`, `.line`, `.total`
 * - Confidence in `.confidence`, `.rating`, `.grade`
 */
export class HashtagBasketballAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'hashtagbasketball',
    name: 'Hashtag Basketball',
    baseUrl: 'https://hashtagbasketball.com',
    fetchMethod: 'http',
    paths: {
      nba: '/nba-picks-today/',
    },
    cron: '0 0 10,14,18 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    $(
      '.pick-card, .game-card, .prediction-row, .picks-table tbody tr, ' +
      '.game-container, .matchup-card, article.pick, .nba-pick',
    ).each((_i, el) => {
      const $row = $(el);

      // Extract team names
      const matchupText = $row.find(
        '.matchup, .teams, .team-names, h2, h3, .game-header',
      ).first().text().trim();
      const teams = this.extractTeams($row, matchupText);
      if (!teams) return;

      const { home, away } = teams;

      // Pick side
      const pickText = $row.find(
        '.pick, .selected, .winner, .pick-team, strong, .best-bet',
      ).first().text().trim();
      const side = this.resolveSide(pickText, home, away);

      // Game time
      const gameTime = $row.find('.game-time, .start-time, .time, .tip-off').text().trim() || null;

      // Confidence
      const confText = $row.find('.confidence, .rating, .grade, .stars, .strength').text().trim();
      const confidence = this.inferConfidence(confText);

      // Reasoning
      const reasoning = $row.find(
        '.analysis, .write-up, .reasoning, .description, p.analysis',
      ).first().text().trim().slice(0, 300) || null;

      // Pick type
      const cardText = $row.text().toLowerCase();
      const pickType = this.inferPickType(cardText);

      // Value
      let value: number | null = null;
      if (pickType === 'spread') {
        value = this.parseSpreadValue($row.find('.spread, .line, .ats-value, td:nth-child(3)').text());
      } else if (pickType === 'over_under') {
        value = this.parseTotalValue($row.find('.total, .ou-line, .over-under, td:nth-child(4)').text());
      } else if (pickType === 'moneyline') {
        value = this.parseMoneylineValue($row.find('.moneyline, .ml, .odds, td:nth-child(2)').text());
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
        pickerName: 'Hashtag Basketball',
        confidence,
        reasoning,
        fetchedAt,
      });
    });

    return predictions;
  }

  private extractTeams(
    $row: ReturnType<ReturnType<typeof this.load>>,
    matchupText: string,
  ): { home: string; away: string } | null {
    // Try "Away @ Home" / "Away vs Home"
    const vsMatch = matchupText.match(/^(.+?)\s+(?:@|vs\.?|at)\s+(.+?)$/i);
    if (vsMatch) {
      return { away: vsMatch[1]!.trim(), home: vsMatch[2]!.trim() };
    }

    // Try separate team elements
    const teamEls = $row.find('.team-name, .team, td.team');
    if (teamEls.length >= 2) {
      return {
        away: teamEls.eq(0).text().trim(),
        home: teamEls.eq(1).text().trim(),
      };
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
