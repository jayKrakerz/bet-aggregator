import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * CBS Sports adapter.
 *
 * CBS Sports publishes expert picks in server-rendered expert panels.
 *
 * Actual structure (as of 2026-02):
 *   - `div.experts-panel` — one per game
 *     - `div.experts-panel-heading` — game header
 *       - `div.game-info-team span.team` — team names (away first, home second)
 *       - `div.game-odds` — spread/total line
 *     - `div.picks-table` — expert picks table
 *       - `div.picks-tr` — one per expert
 *         - `div.expert-name` — expert name
 *         - `div.picks-spread` — spread pick
 *         - `div.picks-o-u` — over/under pick
 *           - `div.pick-over` / `div.pick-under` — O/U direction
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
    await page.waitForSelector('.experts-panel, .picks-table', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    const gameDate = fetchedAt.toISOString().split('T')[0]!;

    $('div.experts-panel').each((_i, panelEl) => {
      const panel = $(panelEl);

      // Extract team names from heading
      const heading = panel.find('.experts-panel-heading');
      const teamEls = heading.find('.game-info-team .team');
      const awayTeamRaw = teamEls.eq(0).text().trim();
      const homeTeamRaw = teamEls.eq(1).text().trim();

      if (!awayTeamRaw || !homeTeamRaw) return;

      // Extract game odds line for spread/total values
      const oddsText = heading.find('.game-odds').text().trim();
      const totalMatch = oddsText.match(/[oO]([\d.]+)/);
      const totalValue = totalMatch ? parseFloat(totalMatch[1]!) : null;

      // Iterate expert pick rows
      panel.find('.picks-tbody .picks-tr').each((_j, rowEl) => {
        const row = $(rowEl);
        const expertName = row.find('.expert-name').text().trim();
        if (!expertName) return;

        // Spread pick — text in picks-spread cell indicates team picked
        const spreadCell = row.find('.picks-spread');
        const spreadText = spreadCell.text().trim();
        if (spreadText) {
          const side: Side = this.resolveTeamSide(spreadText, homeTeamRaw, awayTeamRaw);
          const spreadVal = this.parseSpreadFromText(spreadText);

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime: null,
            pickType: 'spread',
            side,
            value: spreadVal,
            pickerName: expertName,
            confidence: null,
            reasoning: null,
            fetchedAt,
          });
        }

        // Over/under pick
        const ouCell = row.find('.picks-o-u');
        const hasOver = ouCell.find('.pick-over').length > 0;
        const hasUnder = ouCell.find('.pick-under').length > 0;

        if (hasOver || hasUnder) {
          const side: Side = hasOver ? 'over' : 'under';

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime: null,
            pickType: 'over_under',
            side,
            value: totalValue,
            pickerName: expertName,
            confidence: null,
            reasoning: null,
            fetchedAt,
          });
        }
      });
    });

    return predictions;
  }

  private resolveTeamSide(pickText: string, homeTeam: string, awayTeam: string): Side {
    const text = pickText.toUpperCase();
    // Check if the pick text contains the home or away team name/abbreviation
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

  private parseSpreadFromText(text: string): number | null {
    const match = text.match(/([+-]?\d+\.?\d*)/);
    return match ? parseFloat(match[1]!) : null;
  }
}
