import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * NowGoal adapter.
 *
 * STATUS: NEEDS BROWSER - /predictions.htm returns a JS redirect to /lander
 * when using HTTP fetch as of 2026-03-10. Changed fetchMethod to 'browser'
 * to allow the redirect and JS execution.
 *
 * Nowgoal.co provides football predictions and analysis, similar to Goaloo
 * (same family of sites). Uses a dense table layout with odds data.
 *
 * Expected page structure:
 * - Predictions in `table.odds-table` or `#table-matches`
 * - League headers as `tr.league` or `tr` with `colspan` cells
 * - Match rows with columns:
 *   - Num: match number
 *   - Time: HH:MM kickoff
 *   - League: competition abbreviation
 *   - Home: home team name (link)
 *   - VS / Score
 *   - Away: away team name (link)
 *   - Handicap: Asian handicap line
 *   - O/U: Over/Under total line
 *   - Win/Draw/Lose: 1X2 odds (3 columns)
 *   - Analysis: link to detailed analysis
 *
 * Predictions are derived from the odds movement and handicap analysis.
 * The site may use JavaScript for real-time odds updates but initial
 * match data is typically server-rendered.
 */
export class NowgoalAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'nowgoal',
    name: 'NowGoal',
    baseUrl: 'https://www.nowgoal.co',
    fetchMethod: 'browser',
    paths: {
      football: '/predictions.htm',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentLeague = '';

    $('table#table-matches tr, table.odds-table tr, table.match-list tr').each((_i, el) => {
      const $row = $(el);

      // League header: rows with colspan or league class
      const colspanCell = $row.find('td[colspan]');
      if (colspanCell.length && parseInt(colspanCell.attr('colspan') || '0', 10) >= 3) {
        currentLeague = colspanCell.text().trim().replace(/\s+/g, ' ');
        return;
      }
      if ($row.hasClass('league') || $row.hasClass('league-header')) {
        currentLeague = $row.text().trim().replace(/\s+/g, ' ');
        return;
      }

      const cells = $row.find('td');
      if (cells.length < 6) return;

      // Find teams (cells with links or specific classes)
      let homeTeam = '';
      let awayTeam = '';

      // Try class-based selection
      homeTeam = $row.find('td.home a, td.team-home a, .home-team').text().trim();
      awayTeam = $row.find('td.away a, td.team-away a, .away-team').text().trim();

      // Fallback: find two cells with links that look like team names
      if (!homeTeam || !awayTeam) {
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
      }
      if (!homeTeam || !awayTeam) return;

      // Extract time
      let gameTime: string | null = null;
      cells.each((_j, cell) => {
        const text = $(cell).text().trim();
        if (/^\d{1,2}:\d{2}$/.test(text) && !gameTime) {
          gameTime = text;
        }
      });

      // Extract 1X2 odds
      const odds: number[] = [];
      cells.each((_j, cell) => {
        const text = $(cell).text().trim();
        const num = parseFloat(text);
        if (!isNaN(num) && num >= 1.01 && num <= 50 && /^\d+\.\d{2}$/.test(text)) {
          odds.push(num);
        }
      });

      // Extract handicap and O/U lines
      const handicapText = $row.find('.handicap, td.ahc, [class*="handicap"]').text().trim();
      const ouLineText = $row.find('.ou-line, td.ou, [class*="total"]').text().trim();
      const ouLine = parseFloat(ouLineText);

      // Prediction: look for highlighted/marked cell or tip
      const tipEl = $row.find('.prediction, .tip, .pick, td.pred, td b, td strong');
      let tip = tipEl.text().trim();

      // If no explicit tip, derive from odds (lowest odds = most likely)
      let side: Side | null = null;
      if (tip) {
        side = this.mapTipToSide(tip);
      }
      if (!side && odds.length >= 3) {
        side = this.deriveFromOdds(odds);
      }
      if (!side) return;

      const confidence = odds.length >= 3 ? this.oddsToConfidence(odds, side) : null;

      // 1X2 prediction
      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate: fetchedAt.toISOString().split('T')[0]!,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'NowGoal',
        confidence,
        reasoning: [
          currentLeague,
          odds.length >= 3 ? `Odds: ${odds[0]}/${odds[1]}/${odds[2]}` : '',
          handicapText ? `AHC: ${handicapText}` : '',
        ].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });

      // Over/Under prediction if line is available
      if (!isNaN(ouLine) && odds.length >= 5) {
        // O/U odds are typically after the 1X2 odds
        const overOdds = odds[3];
        const underOdds = odds[4];
        if (overOdds && underOdds) {
          const ouSide: Side = overOdds < underOdds ? 'over' : 'under';
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: homeTeam,
            awayTeamRaw: awayTeam,
            gameDate: fetchedAt.toISOString().split('T')[0]!,
            gameTime,
            pickType: 'over_under',
            side: ouSide,
            value: ouLine,
            pickerName: 'NowGoal',
            confidence: overOdds < 1.7 || underOdds < 1.7 ? 'high' : 'medium',
            reasoning: `${currentLeague} | O/U ${ouLine}: ${overOdds}/${underOdds}`,
            fetchedAt,
          });
        }
      }
    });

    return predictions;
  }

  private mapTipToSide(tip: string): Side | null {
    const t = tip.toUpperCase().trim();
    if (t === '1' || t === 'HOME' || t === 'W1') return 'home';
    if (t === '2' || t === 'AWAY' || t === 'W2') return 'away';
    if (t === 'X' || t === 'DRAW' || t === 'D' || t === '0') return 'draw';
    if (t === '1X') return 'home';
    if (t === 'X2') return 'away';
    return null;
  }

  private deriveFromOdds(odds: number[]): Side {
    const [home, draw, away] = odds;
    const min = Math.min(home!, draw!, away!);
    if (min === home) return 'home';
    if (min === away) return 'away';
    return 'draw';
  }

  private oddsToConfidence(odds: number[], side: Side): Confidence {
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
