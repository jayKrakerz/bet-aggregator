import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * CBS Sports adapter.
 *
 * CBS Sports publishes expert picks in a flat table layout (as of 2026-02):
 *
 *   - `div.experts-panel` — single sidebar with expert info
 *     - `span.expert-name` — picker name (e.g. "CBS Sports Staff")
 *   - `div.picks-table` — main picks table
 *     - `div.picks-tbody` — table body
 *       - `div.picks-tr` — one row per game
 *         - `div.game-info-team span.team` (x2) — away first, home second
 *         - `a[href*="gametracker"]` — preview link with date + team codes
 *           in format: `NBA_YYYYMMDD_AWAY@HOME`
 *         - `div.game-odds.over` — total line (e.g. "o234.5")
 *         - `div.game-odds:not(.over)` — spread line (e.g. "+10.5")
 *         - `div.expert-picks-col`
 *           - `div.expert-spread` — spread pick text (e.g. "PHI -10.5"),
 *             with `.expert-logo a[href]` containing picked team code
 *           - `div.expert-ou` — O/U pick
 *             - `span.pick-over` or `span.pick-under` — direction
 */
export class CbsSportsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'cbs-sports',
    name: 'CBS Sports',
    baseUrl: 'https://www.cbssports.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/nba/expert-picks/',
      nfl: '/nfl/expert-picks/',
      mlb: '/mlb/expert-picks/',
      nhl: '/nhl/expert-picks/',
    },
    cron: '0 0 9,13,17 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('.picks-table .picks-tbody .picks-tr', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    const fallbackDate = fetchedAt.toISOString().split('T')[0]!;

    // Expert name comes from the sidebar panel (single expert per page)
    const pickerName =
      $('.experts-panel .expert-name').first().text().trim() || 'CBS Sports Staff';

    // Each row in picks-tbody is one game
    $('.picks-tbody .picks-tr').each((_i, rowEl) => {
      const row = $(rowEl);

      // Extract team names — away first, home second
      const teamEls = row.find('.game-info-team .team');
      if (teamEls.length < 2) return; // skip header rows

      const awayTeamRaw = teamEls.eq(0).text().trim();
      const homeTeamRaw = teamEls.eq(1).text().trim();
      if (!awayTeamRaw || !homeTeamRaw) return;

      // Extract game date from preview link (e.g. NBA_20260224_PHI@IND)
      const previewHref = row.find('a[href*="gametracker"]').attr('href') ?? '';
      const dateMatch = previewHref.match(/(\d{4})(\d{2})(\d{2})/);
      const gameDate = dateMatch
        ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
        : fallbackDate;

      // Extract game time from the formatted time element
      const gameTime = row.find('.current-status .formatter').text().trim() || null;

      // Determine away/home team codes from the preview link (AWAY@HOME)
      const codesMatch = previewHref.match(/\d{8}_([A-Z]+)@([A-Z]+)/);
      const awayCode = codesMatch?.[1] ?? '';
      const homeCode = codesMatch?.[2] ?? '';

      // --- Spread pick ---
      const expertSpread = row.find('.expert-spread');
      if (expertSpread.length) {
        const spreadText = expertSpread.text().trim().replace(/\s+/g, ' ');
        const spreadVal = this.parseNumberFromText(spreadText);

        // Determine which side was picked by matching team code from the
        // expert-logo link or from the text itself
        const pickedCode = this.extractPickedTeamCode(expertSpread);
        const side: Side = this.resolveTeamSide(
          pickedCode || spreadText,
          homeTeamRaw, awayTeamRaw,
          homeCode, awayCode,
        );

        if (spreadText) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'spread',
            side,
            value: spreadVal,
            pickerName,
            confidence: null,
            reasoning: null,
            fetchedAt,
          });
        }
      }

      // --- Over/under pick ---
      const expertOu = row.find('.expert-ou');
      if (expertOu.length) {
        const hasOver = expertOu.find('.pick-over').length > 0;
        const hasUnder = expertOu.find('.pick-under').length > 0;

        if (hasOver || hasUnder) {
          const side: Side = hasOver ? 'over' : 'under';

          // Total value from the O/U pick text (e.g. "O234.5") or from odds
          const ouText = expertOu.text().trim();
          let totalValue = this.parseNumberFromText(ouText);

          // Fallback: parse from the game-odds.over element
          if (totalValue === null) {
            const oddsOverText = row.find('.game-odds.over').text().trim();
            totalValue = this.parseNumberFromText(oddsOverText);
          }

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'over_under',
            side,
            value: totalValue,
            pickerName,
            confidence: null,
            reasoning: null,
            fetchedAt,
          });
        }
      }
    });

    return predictions;
  }

  /** Extract picked team code from the expert-logo anchor href. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractPickedTeamCode(el: any): string {
    const href: string = el.find('.expert-logo a').attr('href') ?? '';
    const match = href.match(/\/teams\/([A-Z]+)\//i);
    return match ? match[1]!.toUpperCase() : '';
  }

  /** Resolve picked side to home/away using team codes and names. */
  private resolveTeamSide(
    pickIndicator: string,
    homeTeam: string,
    awayTeam: string,
    homeCode: string,
    awayCode: string,
  ): Side {
    const text = pickIndicator.toUpperCase();

    // First check against team codes from the preview link (most reliable)
    if (homeCode && text.includes(homeCode)) return 'home';
    if (awayCode && text.includes(awayCode)) return 'away';

    // Fallback: check against team name words
    const homeWords = homeTeam.toUpperCase().split(/\s+/);
    const awayWords = awayTeam.toUpperCase().split(/\s+/);

    for (const word of homeWords) {
      if (word.length >= 3 && text.includes(word)) return 'home';
    }
    for (const word of awayWords) {
      if (word.length >= 3 && text.includes(word)) return 'away';
    }
    return 'home';
  }

  /** Parse a numeric value from text containing a spread or total. */
  private parseNumberFromText(text: string): number | null {
    const match = text.match(/([+-]?\d+\.?\d*)/);
    return match ? parseFloat(match[1]!) : null;
  }
}
