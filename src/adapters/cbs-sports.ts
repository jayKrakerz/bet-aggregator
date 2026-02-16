import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * CBS Sports adapter.
 *
 * CBS Sports publishes expert picks as a dynamically-loaded grid (Next.js).
 * Requires browser rendering to capture the picks table.
 *
 * Page structure:
 *   - `.picks-grid` — container for all game cards
 *   - `.game-card` — one per game
 *     - `.game-teams` — away-team @ home-team
 *     - `.game-info` — time, spread, total
 *     - `.expert-picks-table` — rows of expert picks
 *       - `.expert-row` — one per expert
 *         - `.expert-name` — e.g. "Brad Botkin"
 *         - `.expert-record` — e.g. "(85-62 ATS)"
 *         - `.pick-ats` — spread pick (team + value)
 *         - `.pick-su` — straight-up/moneyline pick (team)
 *         - `.pick-ou` — over/under pick (side + value)
 *
 * Each expert generates up to 3 RawPredictions per game (spread, ML, O/U).
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
    await page.waitForSelector('.picks-grid, .expert-picks-table', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    const dateText = $('.picks-date').text().trim();
    const gameDate = this.parseDateText(dateText, fetchedAt);

    $('.game-card').each((_i, cardEl) => {
      const card = $(cardEl);

      const awayTeamRaw = card.find('.away-team').text().trim();
      const homeTeamRaw = card.find('.home-team').text().trim();
      const gameTime = card.find('.game-time').text().trim() || null;
      const awayAbbr = card.find('.away-team').attr('data-abbr') || '';
      const homeAbbr = card.find('.home-team').attr('data-abbr') || '';

      if (!awayTeamRaw || !homeTeamRaw) return;

      card.find('.expert-row').each((_j, rowEl) => {
        const row = $(rowEl);
        const expertName = row.find('.expert-name').text().trim();
        const recordText = row.find('.expert-record').text().trim();
        const confidence = this.mapRecordToConfidence(recordText);

        if (!expertName) return;

        // ATS (spread) pick
        const atsCell = row.find('.pick-ats');
        const atsTeam = atsCell.find('.pick-team').text().trim();
        const atsValue = this.parseSpreadValue(atsCell.find('.pick-value').text());

        if (atsTeam) {
          const side: Side = this.resolveTeamSide(atsTeam, homeAbbr, awayAbbr, homeTeamRaw, awayTeamRaw);

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'spread',
            side,
            value: atsValue,
            pickerName: expertName,
            confidence,
            reasoning: recordText || null,
            fetchedAt,
          });
        }

        // SU (moneyline) pick
        const suCell = row.find('.pick-su');
        const suTeam = suCell.find('.pick-team').text().trim();

        if (suTeam) {
          const side: Side = this.resolveTeamSide(suTeam, homeAbbr, awayAbbr, homeTeamRaw, awayTeamRaw);

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
            pickerName: expertName,
            confidence,
            reasoning: recordText || null,
            fetchedAt,
          });
        }

        // O/U pick
        const ouCell = row.find('.pick-ou');
        const ouSideText = ouCell.find('.pick-side').text().trim().toLowerCase();
        const ouValue = this.parseTotalValue(ouCell.find('.pick-value').text());

        if (ouSideText === 'over' || ouSideText === 'under') {
          const side: Side = ouSideText as Side;

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'over_under',
            side,
            value: ouValue,
            pickerName: expertName,
            confidence,
            reasoning: recordText || null,
            fetchedAt,
          });
        }
      });
    });

    return predictions;
  }

  private resolveTeamSide(
    pickTeam: string,
    homeAbbr: string,
    awayAbbr: string,
    homeTeamRaw: string,
    awayTeamRaw: string,
  ): Side {
    const pick = pickTeam.toUpperCase();
    if (pick === homeAbbr.toUpperCase() || homeTeamRaw.toUpperCase().includes(pick)) {
      return 'home';
    }
    if (pick === awayAbbr.toUpperCase() || awayTeamRaw.toUpperCase().includes(pick)) {
      return 'away';
    }
    return 'home';
  }

  private mapRecordToConfidence(recordText: string): Confidence | null {
    // Parse "(85-62 ATS)" → win rate
    const match = recordText.match(/(\d+)-(\d+)/);
    if (!match) return null;
    const wins = parseInt(match[1]!, 10);
    const losses = parseInt(match[2]!, 10);
    const total = wins + losses;
    if (total === 0) return null;
    const pct = wins / total;
    if (pct >= 0.60) return 'high';
    if (pct >= 0.52) return 'medium';
    return 'low';
  }

  private parseDateText(text: string, fetchedAt: Date): string {
    const match = text.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (match) {
      const months: Record<string, string> = {
        january: '01', february: '02', march: '03', april: '04',
        may: '05', june: '06', july: '07', august: '08',
        september: '09', october: '10', november: '11', december: '12',
      };
      const m = months[match[1]!.toLowerCase()];
      if (m) {
        const d = match[2]!.padStart(2, '0');
        return `${match[3]}-${m}-${d}`;
      }
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
