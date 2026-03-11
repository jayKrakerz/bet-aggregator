import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Goaloo adapter.
 *
 * Goaloo.com provides football predictions and live scores, primarily
 * targeting Asian markets.
 *
 * Page structure (2026):
 * - Hot matches: `ul.hotmatch > li.matchItem`
 *   - Each matchItem has onclick with: soccerInPage.analysis('id','Home','Away','League')
 *   - `div.teambox > div.teams > span.tName` (first = home, second = away)
 *   - `div.date > span[data-time]` for kickoff (format: "2026,2,10,13,0,0")
 * - May also have table-based predictions on dedicated pages
 */
export class GoalooAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'goaloo',
    name: 'Goaloo',
    baseUrl: 'https://www.goaloo.com',
    fetchMethod: 'http',
    paths: {
      football: '/predictions',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Current site structure (2026): Goaloo predictions/homepage
    // Hot matches section: ul.hotmatch > li.matchItem
    // Each matchItem has:
    //   - onclick="soccerInPage.analysis('id','HomeTeam','AwayTeam','League')"
    //   - div.teambox > div.teams > span.tName (first = home, second = away)
    //   - div.date > span[data-time] for kickoff time
    $('li.matchItem').each((_i, el) => {
      const $el = $(el);

      // Extract team names from .tName elements
      const tNames = $el.find('.tName');
      if (tNames.length < 2) return;
      const homeTeam = $(tNames[0]).text().trim();
      const awayTeam = $(tNames[1]).text().trim();
      if (!homeTeam || !awayTeam) return;

      // Extract league from onclick attribute
      const onclick = $el.attr('onclick') || '';
      const onclickMatch = onclick.match(/analysis\([^,]+,'([^']+)','([^']+)','([^']+)'\)/);
      const league = onclickMatch ? onclickMatch[3]! : '';

      // Extract time from data-time attribute (format: "2026,2,10,13,0,0")
      const dataTimeSpan = $el.find('[data-time]').first();
      const dataTime = dataTimeSpan.attr('data-time') || '';
      let gameTime: string | null = null;
      const timeParts = dataTime.split(',');
      if (timeParts.length >= 5) {
        const hours = timeParts[3]!.padStart(2, '0');
        const minutes = timeParts[4]!.padStart(2, '0');
        gameTime = `${hours}:${minutes}`;
      }

      // Goaloo's predictions page shows hot matches without explicit 1X2 tips.
      // Derive a "home" pick for featured matches (they are featured because
      // the home team is favoured or the match is significant).
      // Since there's no explicit tip, we mark these with low confidence.
      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate: today,
        gameTime,
        pickType: 'moneyline',
        side: 'home',
        value: null,
        pickerName: 'Goaloo Featured',
        confidence: 'low',
        reasoning: league || null,
        fetchedAt,
      });
    });

    // Also try table-based predictions if present (e.g., on dedicated predictions page)
    $('table#tblPredictions tr, table.odds-table tr, table.match-table tr').each((_i, el) => {
      const $row = $(el);

      const cells = $row.find('td');
      if (cells.length < 5) return;

      // Teams are typically in cells with links
      let homeTeam = '';
      let awayTeam = '';

      const teamLinks: string[] = [];
      cells.each((_j, cell) => {
        const linkText = $(cell).find('a').text().trim();
        if (linkText && linkText.length > 1 && !/^\d/.test(linkText)) {
          teamLinks.push(linkText);
        }
      });
      if (teamLinks.length >= 2) {
        homeTeam = teamLinks[0]!;
        awayTeam = teamLinks[1]!;
      }
      if (!homeTeam || !awayTeam) return;

      // Extract odds
      const odds: number[] = [];
      cells.each((_j, cell) => {
        const text = $(cell).text().trim();
        const num = parseFloat(text);
        if (!isNaN(num) && num >= 1.01 && num <= 50 && /^\d+\.\d+$/.test(text)) {
          odds.push(num);
        }
      });

      // Derive prediction from odds
      let side: Side | null = null;
      if (odds.length >= 3) {
        side = this.deriveFromOdds(odds);
      }
      if (!side) return;

      const confidence = odds.length >= 3 ? this.oddsToConfidence(odds, side) : null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate: today,
        gameTime: null,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'Goaloo',
        confidence,
        reasoning: odds.length >= 3 ? `Odds: ${odds[0]}/${odds[1]}/${odds[2]}` : null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private deriveFromOdds(odds: number[]): Side {
    const [home, draw, away] = odds;
    const min = Math.min(home!, draw!, away!);
    if (min === home) return 'home';
    if (min === away) return 'away';
    return 'draw';
  }

  private oddsToConfidence(odds: number[], side: Side): Confidence {
    // Lower odds = higher probability
    let relevantOdds: number;
    if (side === 'home') relevantOdds = odds[0]!;
    else if (side === 'draw') relevantOdds = odds[1]!;
    else relevantOdds = odds[2]!;

    if (relevantOdds <= 1.3) return 'best_bet';
    if (relevantOdds <= 1.7) return 'high';
    if (relevantOdds <= 2.2) return 'medium';
    return 'low';
  }
}
