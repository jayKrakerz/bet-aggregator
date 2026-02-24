import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence, PickType } from '../types/prediction.js';

/**
 * ScoresAndOdds adapter.
 *
 * ScoresAndOdds provides public betting consensus data as server-rendered HTML.
 * Each game has 3 trend cards (moneyline, spread, total) grouped by data-group.
 *
 * Actual structure (as of 2026-02):
 *   - `div.trend-card.consensus` — one card per game × bet type
 *     - classes: `.consensus-table-moneyline--N`, `.consensus-table-spread--N`, `.consensus-table-total--N`
 *   - `div.event-header` — team names + game time
 *     - `div.team-pennant span.team-name` — team name (first = away, second = home)
 *     - `span[data-role="localtime"]` — game time
 *   - `span.percentage-a` / `span.percentage-b` — consensus percentages
 *   - `span.data-moneyline` — moneyline values
 *   - `small.data-odds` — spread/total values
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

    const gameDate = fetchedAt.toISOString().split('T')[0]!;

    $('div.trend-card.consensus').each((_i, el) => {
      const card = $(el);

      // Determine bet type from card class
      const cardClass = card.attr('class') || '';
      let pickType: PickType;
      if (cardClass.includes('consensus-table-moneyline')) {
        pickType = 'moneyline';
      } else if (cardClass.includes('consensus-table-spread')) {
        pickType = 'spread';
      } else if (cardClass.includes('consensus-table-total')) {
        pickType = 'over_under';
      } else {
        return;
      }

      // Extract team names from event header
      const header = card.find('.event-header');
      const teamNames = header.find('.team-pennant .team-name');
      const awayTeamRaw = teamNames.eq(0).text().trim();
      const homeTeamRaw = teamNames.eq(1).text().trim();

      if (!awayTeamRaw || !homeTeamRaw) return;

      const gameTime = header.find('span[data-role="localtime"]').text().trim() || null;

      // Extract percentages
      const pctA = this.parsePercent(card.find('.percentage-a').first().text());
      const pctB = this.parsePercent(card.find('.percentage-b').first().text());

      if (pctA == null || pctB == null) return;

      if (pickType === 'moneyline') {
        // pctA = away ML %, pctB = home ML %
        const side: Side = pctA > pctB ? 'away' : 'home';
        const pct = Math.max(pctA, pctB);

        // Extract moneyline odds
        const mlValues = card.find('.data-moneyline');
        const awayMl = this.parseMoneylineValue(mlValues.eq(0).text());
        const homeMl = this.parseMoneylineValue(mlValues.eq(1).text());

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'moneyline',
          side,
          value: side === 'away' ? awayMl : homeMl,
          pickerName: 'ScoresAndOdds Consensus',
          confidence: this.mapPercentToConfidence(pct),
          reasoning: `Public: ${pct}% on ${side}`,
          fetchedAt,
        });
      } else if (pickType === 'spread') {
        const side: Side = pctA > pctB ? 'away' : 'home';
        const pct = Math.max(pctA, pctB);

        // Extract spread values from data-odds
        const oddsValues = card.find('.data-odds');
        const awaySpread = this.parseSpreadValue(oddsValues.eq(0).text());
        const homeSpread = this.parseSpreadValue(oddsValues.eq(1).text());

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'spread',
          side,
          value: side === 'away' ? awaySpread : homeSpread,
          pickerName: 'ScoresAndOdds Consensus',
          confidence: this.mapPercentToConfidence(pct),
          reasoning: `Public: ${pct}% on ${side}`,
          fetchedAt,
        });
      } else if (pickType === 'over_under') {
        // pctA = over %, pctB = under %
        const side: Side = pctA > pctB ? 'over' : 'under';
        const pct = Math.max(pctA, pctB);

        // Extract total value
        const oddsValues = card.find('.data-odds');
        const totalText = oddsValues.eq(0).text().trim();
        const totalValue = this.parseTotalValue(totalText);

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
    const match = text.match(/(\d+)/);
    return match ? parseInt(match[1]!, 10) : null;
  }

  private mapPercentToConfidence(pct: number): Confidence | null {
    if (pct >= 75) return 'best_bet';
    if (pct >= 65) return 'high';
    if (pct >= 55) return 'medium';
    return 'low';
  }
}
