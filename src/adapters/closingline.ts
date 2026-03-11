import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Closing Line adapter.
 *
 * Scrapes MLB picks from closingline.com.
 * Publishes daily MLB picks with moneyline, run line, and totals.
 *
 * Expected structure:
 * - `.pick-card`, `.game-card`, `.prediction-row`, or table rows
 * - Team names in `.team`, `.team-name`, matchup headers
 * - Pick type (ML, RL, O/U) in `.pick-type`, `.bet-type`, labels
 * - Value in `.line`, `.odds`, `.spread`, `.total`
 * - Analysis text in `.analysis`, `.reasoning`, `.write-up`
 */
export class ClosingLineAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'closingline',
    name: 'Closing Line',
    baseUrl: 'https://www.closingline.com',
    fetchMethod: 'http',
    paths: {
      mlb: '/mlb-picks/',
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
      '.pick-card, .game-card, .prediction-row, .matchup-card, ' +
      'table.picks tbody tr, article.pick, .game-pick, .mlb-pick, ' +
      '.pick-container, .daily-pick',
    ).each((_i, el) => {
      const $card = $(el);

      // Extract teams
      const matchupText = $card.find(
        '.matchup, .teams, .game-title, h2, h3, .header, .team-names',
      ).first().text().trim();
      const teams = this.extractTeams($card, matchupText);
      if (!teams) return;

      const { home, away } = teams;

      // Game time
      const gameTime = $card.find('.game-time, .time, .start-time, .first-pitch').text().trim() || null;

      // Confidence
      const confText = $card.find(
        '.confidence, .rating, .grade, .strength, .units',
      ).text().trim();
      const confidence = this.inferConfidence(confText);

      // Reasoning
      const reasoning = $card.find(
        '.analysis, .write-up, .reasoning, .breakdown, .description, p',
      ).first().text().trim().slice(0, 300) || null;

      // Picker name
      const pickerName = $card.find(
        '.author, .handicapper, .picker, .expert',
      ).text().trim() || 'Closing Line';

      // Determine pick type and details
      const pickTypeText = $card.find(
        '.pick-type, .bet-type, .wager-type, label',
      ).text().trim().toLowerCase();
      const pickText = $card.find(
        '.pick, .selection, .winner, .selected, strong',
      ).first().text().trim();

      const cardText = $card.text().toLowerCase();
      const pickType = pickTypeText
        ? this.inferPickType(pickTypeText)
        : this.inferPickType(cardText);

      let side: Side;
      let value: number | null = null;

      if (pickType === 'over_under') {
        const ouLower = pickText.toLowerCase();
        side = ouLower.includes('under') ? 'under' : 'over';
        value = this.parseTotalValue(
          $card.find('.total, .ou-line, .over-under, .line').text(),
        );
      } else if (pickType === 'spread') {
        side = this.resolveSide(pickText, home, away);
        value = this.parseSpreadValue(
          $card.find('.spread, .run-line, .line').text(),
        );
      } else {
        side = this.resolveSide(pickText, home, away);
        value = this.parseMoneylineValue(
          $card.find('.odds, .moneyline, .ml, .price').text(),
        );
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
        pickerName,
        confidence,
        reasoning,
        fetchedAt,
      });
    });

    return predictions;
  }

  private extractTeams(
    $card: ReturnType<ReturnType<typeof this.load>>,
    matchupText: string,
  ): { home: string; away: string } | null {
    const vsMatch = matchupText.match(/^(.+?)\s+(?:@|vs\.?|at)\s+(.+?)$/i);
    if (vsMatch) {
      return { away: vsMatch[1]!.trim(), home: vsMatch[2]!.trim() };
    }

    const teamEls = $card.find('.team-name, .team, td.team, .team-label');
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
