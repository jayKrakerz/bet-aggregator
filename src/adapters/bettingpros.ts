import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * BettingPros adapter.
 *
 * BettingPros is a Vue.js SPA that aggregates 150+ expert picks into
 * consensus percentages. Requires browser rendering for Vue hydration.
 *
 * Page structure:
 *   - `.picks-table` — main consensus table
 *   - `.picks-row` — one per game
 *     - `.matchup` — away/home team names + abbreviations
 *     - `.spread-pick .consensus-pick` — consensus spread pick + percentage
 *     - `.ml-pick .consensus-pick` — consensus ML pick + percentage
 *     - `.ou-pick .consensus-pick` — consensus O/U pick + percentage
 *     - `.spread-prob .cover-probability` — model cover probability
 *     - `.ml-prob .win-probability` — model win probability
 *     - `.ou-prob .ou-probability` — model O/U probability
 */
export class BettingProsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'bettingpros',
    name: 'BettingPros',
    baseUrl: 'https://www.bettingpros.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/nba/picks/',
      nfl: '/nfl/picks/',
      mlb: '/mlb/picks/',
      nhl: '/nhl/picks/',
      ncaab: '/college-basketball/picks/',
    },
    cron: '0 0 10,14,18,22 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('.picks-table, .consensus-picks-table', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    const dateText = $('.current-date').attr('data-date') || $('.current-date').text().trim();
    const gameDate = this.parseDateValue(dateText, fetchedAt);

    $('tr.picks-row').each((_i, el) => {
      const row = $(el);

      const awayTeamRaw = row.find('.team.away .team-name').text().trim();
      const homeTeamRaw = row.find('.team.home .team-name').text().trim();
      const gameTime = row.find('.game-time').text().trim() || null;

      if (!awayTeamRaw || !homeTeamRaw) return;

      // Spread consensus pick
      const spreadPick = row.find('.spread-pick .consensus-pick');
      const spreadDirection = spreadPick.find('.pick-direction').text().trim().toLowerCase();
      const spreadPct = this.parsePercent(spreadPick.find('.consensus-pct').text());
      const spreadProb = this.parsePercent(row.find('.spread-prob .cover-probability').text());
      const spreadLineSelector = spreadDirection === 'home' ? '.spread-cell .home-line' : '.spread-cell .away-line';
      const spreadValue = this.extractLineValue(row.find(spreadLineSelector).text().trim());
      const spreadExperts = row.find('.spread-pick .expert-count').text();

      if (spreadDirection && spreadPct != null) {
        const side: Side = spreadDirection === 'home' ? 'home' : 'away';

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'spread',
          side,
          value: spreadValue,
          pickerName: 'BettingPros Consensus',
          confidence: this.mapProbToConfidence(spreadProb ?? spreadPct),
          reasoning: this.buildReasoning('Spread', spreadPct, spreadProb, spreadExperts),
          fetchedAt,
        });
      }

      // Moneyline consensus pick
      const mlPick = row.find('.ml-pick .consensus-pick');
      const mlDirection = mlPick.find('.pick-direction').text().trim().toLowerCase();
      const mlPct = this.parsePercent(mlPick.find('.consensus-pct').text());
      const mlProb = this.parsePercent(row.find('.ml-prob .win-probability').text());
      const mlLineSelector = mlDirection === 'home' ? '.ml-cell .home-line' : '.ml-cell .away-line';
      const mlValue = this.extractMlValue(row.find(mlLineSelector).text().trim());
      const mlExperts = row.find('.ml-pick .expert-count').text();

      if (mlDirection && mlPct != null) {
        const side: Side = mlDirection === 'home' ? 'home' : 'away';

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'moneyline',
          side,
          value: mlValue,
          pickerName: 'BettingPros Consensus',
          confidence: this.mapProbToConfidence(mlProb ?? mlPct),
          reasoning: this.buildReasoning('ML', mlPct, mlProb, mlExperts),
          fetchedAt,
        });
      }

      // Over/under consensus pick
      const ouPick = row.find('.ou-pick .consensus-pick');
      const ouSideText = ouPick.find('.pick-side').text().trim().toLowerCase();
      const ouPct = this.parsePercent(ouPick.find('.consensus-pct').text());
      const ouProb = this.parsePercent(row.find('.ou-prob .ou-probability').text());
      const overLineText = row.find('.total-cell .over-line').text().trim();
      const totalLine = this.extractTotalFromLine(overLineText);
      const ouExperts = row.find('.ou-pick .expert-count').text();

      if ((ouSideText === 'over' || ouSideText === 'under') && ouPct != null) {
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
          value: totalLine,
          pickerName: 'BettingPros Consensus',
          confidence: this.mapProbToConfidence(ouProb ?? ouPct),
          reasoning: this.buildReasoning('O/U', ouPct, ouProb, ouExperts),
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private parsePercent(text: string): number | null {
    const num = parseFloat(text.trim());
    return isNaN(num) ? null : num;
  }

  private extractLineValue(lineText: string): number | null {
    // "BOS -6.5 (-110)" → extract -6.5, or "GSW +2.0 (-112)" → +2.0
    const match = lineText.match(/([+-]?\d+\.?\d*)\s*\(/);
    return match ? parseFloat(match[1]!) : this.parseSpreadValue(lineText);
  }

  private extractMlValue(lineText: string): number | null {
    // "BOS -280" → extract -280
    const match = lineText.match(/([+-]?\d+)/);
    return match ? parseInt(match[1]!, 10) : null;
  }

  private extractTotalFromLine(overText: string): number | null {
    // "O 221.5 (-110)" → extract 221.5
    const match = overText.match(/O\s*([\d.]+)/);
    return match ? parseFloat(match[1]!) : null;
  }

  private mapProbToConfidence(prob: number): Confidence {
    if (prob >= 75) return 'best_bet';
    if (prob >= 65) return 'high';
    if (prob >= 55) return 'medium';
    return 'low';
  }

  private buildReasoning(
    market: string,
    consensusPct: number | null,
    modelProb: number | null,
    expertCountText: string,
  ): string {
    const parts: string[] = [];
    if (consensusPct != null) parts.push(`${market} consensus: ${consensusPct}%`);
    if (modelProb != null) parts.push(`Model prob: ${modelProb}%`);
    const expertText = expertCountText.trim();
    if (expertText) parts.push(expertText);
    return parts.join(' | ');
  }

  private parseDateValue(text: string, fetchedAt: Date): string {
    // Try ISO format first: "2026-02-16"
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

    // Try "February 16, 2026"
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
