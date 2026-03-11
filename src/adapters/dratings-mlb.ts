import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * DRatings MLB adapter.
 *
 * STATUS: WORKING - Selectors match the real DOM. The 2026-03-10 snapshot has
 * only 1 upcoming game (Yankees vs Giants, March 25) since it's pre-season,
 * producing 2 predictions (moneyline + over_under). Full output expected once
 * the regular season starts.
 *
 * Scrapes MLB power ratings and predictions from dratings.com/mlb.
 * DRatings uses a `table.table` with `thead.table-header` and `tbody.table-body`:
 *
 * - Column 0 (Time): date in `<time>` element, e.g. "03/26/2026"
 * - Column 1 (Teams): both teams stacked in one cell with `<br>`,
 *     each as `<span><a>Team Name</a> <span>(W-L)</span></span>`
 *     First team = away, second = home
 * - Column 2 (Pitchers): starting pitchers
 * - Column 3 (Win): win probabilities stacked, e.g. `<span class="tc--green">52.8%</span>`
 * - Column 6 (Runs): projected runs per team, stacked
 * - Column 7 (Total Runs): total projected runs
 */
export class DRatingsMlbAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'dratings-mlb',
    name: 'DRatings MLB',
    baseUrl: 'https://www.dratings.com',
    fetchMethod: 'http',
    paths: {
      mlb: '/predictor/mlb-baseball-predictions/',
    },
    cron: '0 0 8,12,16 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // The "Upcoming Games" table uses: table.table > tbody.table-body > tr
    // Only look at the first table in #scroll-upcoming (upcoming games).
    // Column layout:
    //   0: Time (contains <time datetime="..."> with date)
    //   1: Teams (both away & home stacked with <br>, each in a <span> with <a>)
    //   2: Pitchers
    //   3: Win % (two <span> values stacked: away %, home %)
    //   4: Best ML
    //   5: Best Spread
    //   6: Projected Runs per team (stacked: away runs <br> home runs)
    //   7: Total Runs (single number)
    //   8: Best O/U
    //   9: Bet Value
    //  10: Detail link
    $('#scroll-upcoming table.table tbody.table-body tr').each((_i, el) => {
      const $row = $(el);
      const cells = $row.find('td');
      if (cells.length < 8) return;

      // Column 0: Date from <time datetime="..."> (ISO format)
      const timeEl = cells.eq(0).find('time');
      const dateTimeAttr = timeEl.attr('datetime') || '';
      const dateText = timeEl.text().trim();
      let gameDate = today;
      if (dateTimeAttr) {
        const isoDate = dateTimeAttr.split('T')[0];
        if (isoDate) gameDate = isoDate;
      } else {
        gameDate = this.extractDate(dateText) || today;
      }

      // Column 1: Teams - both in one cell, stacked with <br>
      // Each team is in a <span> containing an <a> with the team name
      const teamSpans = cells.eq(1).find('span.table-cell--mw');
      if (teamSpans.length < 2) return;

      const awayTeamRaw = $(teamSpans[0]).find('a').text().trim()
        || $(teamSpans[0]).text().replace(/\([\d-]+\)/, '').trim();
      const homeTeamRaw = $(teamSpans[1]).find('a').text().trim()
        || $(teamSpans[1]).text().replace(/\([\d-]+\)/, '').trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Column 3: Win probabilities (two <span> values stacked)
      const wpSpans = cells.eq(3).find('span');
      let awayWp = 0;
      let homeWp = 0;
      if (wpSpans.length >= 2) {
        awayWp = parseFloat($(wpSpans[0]).text().replace('%', '')) || 0;
        homeWp = parseFloat($(wpSpans[1]).text().replace('%', '')) || 0;
      }

      // Column 6: Projected runs per team (HTML: "4.44<br>4.15")
      // Replace <br> with a separator before extracting text
      const runsCell = cells.eq(6);
      runsCell.find('br').replaceWith('|');
      const runsText = runsCell.text().trim();
      const runsParts = runsText.split('|').map(s => s.trim());
      const awayRuns = runsParts[0] ? parseFloat(runsParts[0]) : 0;
      const homeRuns = runsParts[1] ? parseFloat(runsParts[1]) : 0;

      // Column 7: Total projected runs
      const totalRunsText = cells.eq(7).text().trim();
      const totalRuns = parseFloat(totalRunsText) || (awayRuns + homeRuns);

      // Determine side from win probability
      const side: Side = homeWp >= awayWp ? 'home' : 'away';
      const winProb = Math.max(homeWp, awayWp);
      const confidence = winProb >= 65 ? 'high' as const
        : winProb >= 55 ? 'medium' as const
        : 'low' as const;

      // Extract game time from <time> text (after the date line break)
      const timeText = cells.eq(0).text().trim();
      const timeMatch = timeText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
      const gameTime = timeMatch ? timeMatch[1]! : null;

      // Moneyline prediction
      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'DRatings Model',
        confidence,
        reasoning: [
          winProb ? `Win prob: ${awayWp}%/${homeWp}%` : '',
          awayRuns || homeRuns ? `Projected: ${awayTeamRaw} ${awayRuns} - ${homeTeamRaw} ${homeRuns}` : '',
        ].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });

      // Over/under from projected total
      if (totalRuns > 0) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'over_under',
          side: totalRuns >= 9 ? 'over' : 'under',
          value: Math.round(totalRuns * 2) / 2, // Round to nearest 0.5
          pickerName: 'DRatings Model',
          confidence: 'medium',
          reasoning: `Projected total: ${totalRuns.toFixed(1)} runs`,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private extractDate(text: string): string | null {
    const isoMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1]!;

    const usMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (usMatch) {
      const year = usMatch[3]!.length === 2 ? `20${usMatch[3]}` : usMatch[3]!;
      return `${year}-${usMatch[1]!.padStart(2, '0')}-${usMatch[2]!.padStart(2, '0')}`;
    }

    const mdMatch = text.match(/(\d{1,2})\/(\d{1,2})/);
    if (mdMatch) {
      const now = new Date();
      return `${now.getFullYear()}-${mdMatch[1]!.padStart(2, '0')}-${mdMatch[2]!.padStart(2, '0')}`;
    }

    return null;
  }
}
