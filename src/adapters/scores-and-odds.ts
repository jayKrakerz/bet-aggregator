import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * ScoresAndOdds adapter.
 *
 * ScoresAndOdds provides public betting consensus data as server-rendered
 * HTML tables. Each row represents one game with:
 *   - Team names (away first, home second)
 *   - Spread: line and public betting percentages
 *   - Moneyline: odds and public percentages
 *   - Total (O/U): line and public percentages
 *
 * Selectors:
 *   - `.event-table` — main data table
 *   - `.event-row` — one game per row
 *   - `.matchup-cell` — team names + game time
 *   - `.spread-pct .data-value` — public spread %
 *   - `.ml-pct .data-value` — public moneyline %
 *   - `.total-pct .data-value` — public over/under %
 */
export class ScoresAndOddsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'scores-and-odds',
    name: 'ScoresAndOdds',
    baseUrl: 'https://www.scoresandodds.com',
    fetchMethod: 'http',
    paths: {
      nba: '/nba/consensus-picks',
      nfl: '/nfl/consensus-picks',
      mlb: '/mlb/consensus-picks',
      nhl: '/nhl/consensus-picks',
      ncaab: '/ncaab/consensus-picks',
    },
    cron: '0 0 10,14,18,22 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    const dateText = $('.consensus-date').text().trim();
    const gameDate = this.parseDateText(dateText, fetchedAt);

    $('tr.event-row').each((_i, el) => {
      const row = $(el);

      const awayTeamRaw = row.find('.away-team .team-name').text().trim();
      const homeTeamRaw = row.find('.home-team .team-name').text().trim();
      const gameTime = row.find('.game-time').text().trim() || null;

      if (!awayTeamRaw || !homeTeamRaw) return;

      // Spread consensus
      const spreadPcts = row.find('.spread-pct .data-value');
      const awaySpreadPct = this.parsePercent(spreadPcts.eq(0).text());
      const homeSpreadPct = this.parsePercent(spreadPcts.eq(1).text());

      const spreadOdds = row.find('.spread-odds .data-value');
      const awaySpreadLine = this.parseSpreadValue(spreadOdds.eq(0).text());
      const homeSpreadLine = this.parseSpreadValue(spreadOdds.eq(1).text());

      if (awaySpreadPct != null && homeSpreadPct != null) {
        const side: Side = awaySpreadPct > homeSpreadPct ? 'away' : 'home';
        const pct = Math.max(awaySpreadPct, homeSpreadPct);
        const value = side === 'away' ? awaySpreadLine : homeSpreadLine;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'spread',
          side,
          value,
          pickerName: 'ScoresAndOdds Consensus',
          confidence: this.mapPercentToConfidence(pct),
          reasoning: `Public: ${pct}% on ${side}`,
          fetchedAt,
        });
      }

      // Moneyline consensus
      const mlPcts = row.find('.ml-pct .data-value');
      const awayMlPct = this.parsePercent(mlPcts.eq(0).text());
      const homeMlPct = this.parsePercent(mlPcts.eq(1).text());

      const mlOdds = row.find('.ml-odds .data-value');
      const awayMlOdds = this.parseMoneylineValue(mlOdds.eq(0).text());
      const homeMlOdds = this.parseMoneylineValue(mlOdds.eq(1).text());

      if (awayMlPct != null && homeMlPct != null) {
        const side: Side = awayMlPct > homeMlPct ? 'away' : 'home';
        const pct = Math.max(awayMlPct, homeMlPct);
        const value = side === 'away' ? awayMlOdds : homeMlOdds;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'moneyline',
          side,
          value,
          pickerName: 'ScoresAndOdds Consensus',
          confidence: this.mapPercentToConfidence(pct),
          reasoning: `Public: ${pct}% on ${side}`,
          fetchedAt,
        });
      }

      // Over/under consensus
      const totalPcts = row.find('.total-pct .data-value');
      const overPct = this.parsePercent(totalPcts.eq(0).text());
      const underPct = this.parsePercent(totalPcts.eq(1).text());

      const totalOdds = row.find('.total-odds .data-value');
      const overText = totalOdds.eq(0).text().trim();
      const totalValue = this.parseTotalFromText(overText);

      if (overPct != null && underPct != null) {
        const side: Side = overPct > underPct ? 'over' : 'under';
        const pct = Math.max(overPct, underPct);

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
          pickerName: 'ScoresAndOdds Consensus',
          confidence: this.mapPercentToConfidence(pct),
          reasoning: `Public: ${pct}% on ${side}`,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private parsePercent(text: string): number | null {
    const num = parseInt(text.trim(), 10);
    return isNaN(num) ? null : num;
  }

  private parseTotalFromText(text: string): number | null {
    // Format: "O 221.5" or "U 221.5"
    const match = text.match(/([\d.]+)/);
    return match?.[1] ? parseFloat(match[1]) : null;
  }

  private parseDateText(text: string, fetchedAt: Date): string {
    // Format: "February 16, 2026"
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

  private mapPercentToConfidence(pct: number): Confidence | null {
    if (pct >= 75) return 'best_bet';
    if (pct >= 65) return 'high';
    if (pct >= 55) return 'medium';
    return 'low';
  }
}
