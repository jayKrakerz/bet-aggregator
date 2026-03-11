import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * TotalCorner adapter (totalcorner.com).
 *
 * Static HTML site focused on corner and goal predictions. The /match/today
 * page lists today's matches with over/under predictions for goals and corners.
 *
 * Expected structure:
 *   - Match table: `table.table-matches`, `table#match_list`, `table.tc-table`
 *   - Rows: `tbody tr`, `tr[data-id]`, `tr.match-row`
 *   - Home team: `td.team-home a`, `td:nth-child(2) a`, `.home-team`
 *   - Away team: `td.team-away a`, `td:nth-child(4) a`, `.away-team`
 *   - Over/Under prediction: `td.ou-prediction`, `td[class*="over"]`,
 *     `td[class*="under"]`, `span.prediction`
 *   - Goal line: `td.line`, `span.goal-line`
 *   - Time: `td.match-time`, `td:first-child`
 *   - League: `td.league`, `a[class*="league"]`
 *   - Confidence indicator: `span.stars`, `span[class*="confidence"]`, star icons
 */
export class TotalCornerAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'totalcorner',
    name: 'TotalCorner',
    baseUrl: 'https://www.totalcorner.com',
    fetchMethod: 'http',
    paths: {
      football: '/match/today',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const gameDate = fetchedAt.toISOString().split('T')[0]!;

    // TotalCorner uses table.match_table with tbody.tbody_match
    // Each match row is a <tr> with data-match_id attribute inside tbody.tbody_match
    const rows = $(
      'table.match_table tbody.tbody_match tr[data-match_id], table#inplay_match_table tbody.tbody_match tr[data-match_id]',
    );

    rows.each((_i, el) => {
      const $row = $(el);
      const cells = $row.find('td');
      if (cells.length < 6) return;

      // Parse teams - home is in td.match_home, away in td.match_away
      const homeEl = $row.find('td.match_home a span, td.match_home a');
      const awayEl = $row.find('td.match_away a span, td.match_away a');

      const home = homeEl.first().text().trim();
      const away = awayEl.first().text().trim();
      if (!home || !away) return;

      // Parse time from the time cell (usually 3rd td with text-center)
      const timeCells = $row.find('td.text-center');
      let gameTime: string | null = null;
      timeCells.each((_j, tc) => {
        const text = $(tc).text().trim();
        const tm = text.match(/^(\d{1,2}:\d{2})$/);
        if (tm && !gameTime) {
          gameTime = tm[1]!;
        }
      });

      // Parse league from td.td_league
      const leagueEl = $row.find('td.td_league a');
      const league = leagueEl.first().text().trim();

      // Parse total goals line and odds from td.total_goals
      // Format: "2.5 (1.75)" where 2.5 = goal line, 1.75 = odds
      const totalGoalsEl = $row.find('td.total_goals div.match_total_goal_div');
      const totalGoalsText = totalGoalsEl.first().text().trim();
      const lineMatch = totalGoalsText.match(/([\d.]+)\s*\(([\d.]+)\)/);

      const lineValue = lineMatch ? parseFloat(lineMatch[1]!) : 2.5;
      const totalOdds = lineMatch ? parseFloat(lineMatch[2]!) : 0;

      // Parse current score to determine over/under tendency
      const scoreEl = $row.find('td.match_goal');
      const scoreText = scoreEl.first().text().trim();
      const scoreMatch = scoreText.match(/(\d+)\s*-\s*(\d+)/);
      const currentGoals = scoreMatch
        ? parseInt(scoreMatch[1]!, 10) + parseInt(scoreMatch[2]!, 10)
        : 0;

      // Parse corner data from td.match_corner
      const cornerEl = $row.find('td.match_corner span.span_match_corner');
      const cornerText = cornerEl.first().text().trim();

      // Determine side: if current goals already exceed the line, it's "over"
      // If odds < 2.0, the market favors that outcome
      let side: Side;
      if (currentGoals > lineValue) {
        side = 'over';
      } else if (totalOdds > 0 && totalOdds < 2.0) {
        // Low odds = likely over (the displayed line is the over line)
        side = 'over';
      } else {
        side = 'under';
      }

      // Confidence from odds
      let confidence = this.parseConfidence('', totalGoalsText);
      if (!confidence && totalOdds > 0) {
        const impliedProb = (1 / totalOdds) * 100;
        if (impliedProb >= 75) confidence = 'best_bet';
        else if (impliedProb >= 60) confidence = 'high';
        else if (impliedProb >= 45) confidence = 'medium';
        else confidence = 'low';
      }

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: home,
        awayTeamRaw: away,
        gameDate,
        gameTime,
        pickType: 'over_under',
        side,
        value: lineValue,
        pickerName: 'TotalCorner Stats',
        confidence,
        reasoning: [
          league || null,
          `${side} ${lineValue} goals`,
          cornerText ? `Corners: ${cornerText}` : null,
          totalOdds > 0 ? `Odds: ${totalOdds}` : null,
        ].filter(Boolean).join(' | '),
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseMatchTeams(text: string): { home: string; away: string } | null {
    const separators = [' - ', ' – ', ' vs ', ' v '];
    for (const sep of separators) {
      const idx = text.indexOf(sep);
      if (idx > 0) {
        const home = text.slice(0, idx).trim();
        const away = text.slice(idx + sep.length).trim();
        if (home && away) return { home, away };
      }
    }
    return null;
  }

  private parseConfidence(starsText: string, predText: string): Confidence | null {
    // Stars count (unicode stars or number)
    const starCount = (starsText.match(/★|⭐|\*/g) || []).length;
    if (starCount >= 4) return 'best_bet';
    if (starCount >= 3) return 'high';
    if (starCount >= 2) return 'medium';
    if (starCount >= 1) return 'low';

    // Percentage based
    const pctMatch = predText.match(/(\d+)%/);
    if (pctMatch) {
      const pct = parseInt(pctMatch[1]!, 10);
      if (pct >= 80) return 'best_bet';
      if (pct >= 65) return 'high';
      if (pct >= 50) return 'medium';
      return 'low';
    }

    return null;
  }
}
