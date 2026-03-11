import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * SoccerStats adapter (soccerstats.com).
 *
 * Static HTML site with a classic table-based layout showing recent and
 * upcoming matches with league statistics.
 *
 * Expected structure:
 *   - Match tables: `table.tbl1`, `table[class*="tbl"]`, `table.sortable`,
 *     `table[width="100%"]`
 *   - Rows: `tbody tr`, `tr[class*="odd"]`, `tr[class*="even"]`
 *   - Home team: `td:nth-child(2)`, `td.home`, `a[class*="team"]`
 *   - Score/status: `td:nth-child(3)`, `td.score`, middle column
 *   - Away team: `td:nth-child(4)`, `td.away`
 *   - Stats columns: goal averages, over/under percentages, BTTS %
 *   - League headers: `tr.head`, `td[colspan]`, `th`
 */
export class SoccerStatsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'soccerstats',
    name: 'SoccerStats',
    baseUrl: 'https://www.soccerstats.com',
    fetchMethod: 'http',
    paths: {
      football: '/latest.asp',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const gameDate = fetchedAt.toISOString().split('T')[0]!;
    let currentLeague = '';

    // Try multiple table selectors
    const tables = $('table.tbl1, table[class*="tbl"], table.sortable, table[width="100%"]');

    tables.each((_ti, tableEl) => {
      const $table = $(tableEl);
      const rows = $table.find('tbody tr, tr');

      rows.each((_i, el) => {
        const $row = $(el);
        const cells = $row.find('td');

        // League header row (colspan or single cell with league name)
        if (cells.length <= 2) {
          const headerText = $row.find('td[colspan], th, td.head, td b').first().text().trim();
          if (headerText && headerText.length > 2) {
            currentLeague = headerText;
          }
          return;
        }

        // Skip header/title rows
        if ($row.hasClass('head') || $row.find('th').length > 0) return;
        if (cells.length < 4) return;

        // Try to find teams in standard column layout
        const homeEl = $row.find('td.home, td:nth-child(2) a, td:nth-child(2)');
        const awayEl = $row.find('td.away, td:nth-child(4) a, td:nth-child(4)');

        let home = homeEl.first().text().trim();
        let away = awayEl.first().text().trim();

        // Fallback: combined "Home - Away" text
        if (!home || !away || home === away) {
          for (let ci = 0; ci < cells.length; ci++) {
            const cellText = $(cells[ci]).text().trim();
            const teams = this.parseMatchTeams(cellText);
            if (teams) {
              home = teams.home;
              away = teams.away;
              break;
            }
          }
        }

        if (!home || !away || home.length < 2 || away.length < 2) return;

        // Parse time from first cell
        const timeText = $(cells[0]).text().trim();
        const timeMatch = timeText.match(/(\d{1,2}:\d{2})/);
        const gameTime = timeMatch ? timeMatch[1]! : null;

        // Look for over/under statistics in later columns
        let overPct = 0;
        let underPct = 0;
        let avgGoals = 0;

        cells.each((_ci, cell) => {
          const text = $(cell).text().trim();
          // Look for percentage values that could be O/U stats
          const pctMatch = text.match(/^(\d{1,3})%$/);
          if (pctMatch) {
            const pct = parseInt(pctMatch[1]!, 10);
            if (overPct === 0) overPct = pct;
            else if (underPct === 0) underPct = pct;
          }
          // Average goals
          const goalMatch = text.match(/^(\d+\.\d+)$/);
          if (goalMatch) {
            avgGoals = parseFloat(goalMatch[1]!) || 0;
          }
        });

        // Generate moneyline prediction based on available data
        // Check for any prediction indicators in the row
        const rowText = $row.text().toLowerCase();
        let side: Side = 'home';
        let pickType: RawPrediction['pickType'] = 'moneyline';
        let value: number | null = null;
        let confidence: Confidence | null = null;

        if (overPct > 0 && underPct > 0) {
          // Over/under prediction based on stats
          pickType = 'over_under';
          side = overPct > underPct ? 'over' : 'under';
          value = 2.5;
          const diff = Math.abs(overPct - underPct);
          if (diff >= 40) confidence = 'best_bet';
          else if (diff >= 25) confidence = 'high';
          else if (diff >= 15) confidence = 'medium';
          else confidence = 'low';
        } else if (avgGoals > 0) {
          // Use average goals to predict O/U
          pickType = 'over_under';
          side = avgGoals > 2.5 ? 'over' : 'under';
          value = 2.5;
          const dist = Math.abs(avgGoals - 2.5);
          if (dist >= 1.0) confidence = 'best_bet';
          else if (dist >= 0.6) confidence = 'high';
          else if (dist >= 0.3) confidence = 'medium';
          else confidence = 'low';
        } else {
          // Default moneyline — low confidence without stats
          confidence = 'low';
        }

        const reasoning = [
          currentLeague,
          avgGoals > 0 ? `Avg goals: ${avgGoals}` : '',
          overPct > 0 ? `Over: ${overPct}%` : '',
          underPct > 0 ? `Under: ${underPct}%` : '',
        ].filter(Boolean).join(' | ') || null;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate,
          gameTime,
          pickType,
          side,
          value,
          pickerName: 'SoccerStats Data',
          confidence,
          reasoning,
          fetchedAt,
        });
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
        if (home && away && home.length > 1 && away.length > 1) return { home, away };
      }
    }
    return null;
  }
}
