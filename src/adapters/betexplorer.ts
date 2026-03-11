import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * BetExplorer adapter (betexplorer.com).
 *
 * Static HTML site with tabular match data including odds from multiple
 * bookmakers. The /next/soccer/ page shows upcoming matches with average odds.
 *
 * Expected structure:
 *   - Match table: `table.table-main`, `table[class*="table-main"]`
 *   - Rows: `tr[data-def]`, `tr.table-main__tr`, `tbody tr`
 *   - Home team: `td.h-text-left a`, `.table-main__participants a:first-child`
 *   - Away team: second link or parsed from "Home - Away" text
 *   - Odds cells: `td[data-odd]`, `td.table-main__odds`, `td a[data-odd]`
 *   - Time: `td.h-text-center span`, `td.table-main__time`
 *   - Date headers: `th.h-text-left`, `thead th` with date text
 */
export class BetExplorerAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'betexplorer',
    name: 'BetExplorer',
    baseUrl: 'https://www.betexplorer.com',
    fetchMethod: 'http',
    paths: {
      football: '/next/soccer/',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentDate = fetchedAt.toISOString().split('T')[0]!;

    // Each match is an <li> with class "table-main__tournamentLiContent"
    // containing a <ul class="table-main__matchInfo"> with match data.
    // Date can be parsed from data-dt attribute: data-dt="DD,MM,YYYY,HH,mm"
    const matchItems = $('li.table-main__tournamentLiContent, li[class*="tournamentLiContent"]');

    matchItems.each((_i, el) => {
      const $item = $(el);

      // Parse date from data-dt attribute (format: "DD,MM,YYYY,HH,mm")
      const matchInfo = $item.find('ul.table-main__matchInfo, ul[class*="matchInfo"]');
      const dtAttr = matchInfo.attr('data-dt') || '';
      const dtParts = dtAttr.split(',');
      if (dtParts.length >= 3) {
        const day = (dtParts[0] || '').padStart(2, '0');
        const month = (dtParts[1] || '').padStart(2, '0');
        const year = dtParts[2] || '';
        if (year && month && day) {
          currentDate = `${year}-${month}-${day}`;
        }
      }

      // Parse time from matchHour span
      const timeEl = $item.find('span.table-main__matchHour, span[class*="matchHour"]');
      const gameTime = timeEl.first().text().trim() || null;

      // Parse teams from participant divs
      const homeEl = $item.find('div[class*="participantHome"] p, div.table-main__participantHome p');
      const awayEl = $item.find('div[class*="participantAway"] p, div.table-main__participantAway p');

      let home = homeEl.first().text().trim();
      let away = awayEl.first().text().trim();

      // Fallback: parse from the main link text
      if (!home || !away) {
        const linkEl = $item.find('a[data-live-cell="matchlink"], a[class*="participants"]');
        const linkText = linkEl.text().trim();
        const teams = this.parseMatchTeams(linkText);
        if (teams) {
          home = teams.home;
          away = teams.away;
        }
      }

      if (!home || !away) return;

      // Parse odds (1 X 2) from table-main__odds buttons with data-odd attribute
      const oddsEls = $item.find('div.table-main__odds button[data-odd], div[class*="table-main__odds"] button[data-odd]');
      let odds1 = 0;
      let oddsX = 0;
      let odds2 = 0;

      if (oddsEls.length >= 3) {
        odds1 = parseFloat($(oddsEls[0]).attr('data-odd') || '') || 0;
        oddsX = parseFloat($(oddsEls[1]).attr('data-odd') || '') || 0;
        odds2 = parseFloat($(oddsEls[2]).attr('data-odd') || '') || 0;
      }

      if (odds1 <= 0 && oddsX <= 0 && odds2 <= 0) return;

      // Lowest odds = most likely outcome
      const side = this.oddsToSide(odds1, oddsX, odds2);
      const confidence = this.oddsToConfidence(odds1, oddsX, odds2);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: home,
        awayTeamRaw: away,
        gameDate: currentDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'BetExplorer Avg Odds',
        confidence,
        reasoning: `Odds: ${odds1 || '?'} / ${oddsX || '?'} / ${odds2 || '?'}`,
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

  private oddsToSide(odds1: number, oddsX: number, odds2: number): Side {
    const min = Math.min(
      odds1 > 0 ? odds1 : Infinity,
      oddsX > 0 ? oddsX : Infinity,
      odds2 > 0 ? odds2 : Infinity,
    );
    if (min === odds1) return 'home';
    if (min === odds2) return 'away';
    return 'draw';
  }

  private oddsToConfidence(odds1: number, oddsX: number, odds2: number): Confidence | null {
    const min = Math.min(
      odds1 > 0 ? odds1 : Infinity,
      oddsX > 0 ? oddsX : Infinity,
      odds2 > 0 ? odds2 : Infinity,
    );
    if (min === Infinity) return null;
    const impliedProb = (1 / min) * 100;
    if (impliedProb >= 75) return 'best_bet';
    if (impliedProb >= 60) return 'high';
    if (impliedProb >= 45) return 'medium';
    return 'low';
  }
}
