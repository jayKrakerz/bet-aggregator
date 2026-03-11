import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * NBA-Betting.net adapter.
 *
 * NBA-Betting.net provides daily NBA betting predictions with
 * spread, moneyline, and over/under picks.
 *
 * Page structure:
 * - `.prediction-table, table.picks`: predictions table
 * - `tr.game-row`: each game row
 * - `td.away-team, td.home-team`: team names
 * - `td.spread-pick`: spread prediction
 * - `td.total-pick`: over/under prediction
 * - `td.ml-pick`: moneyline pick
 * - `td.game-date`: game date
 * - `.confidence, .rating`: confidence level
 */
export class NbaBettingAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'nba-betting',
    name: 'NBA-Betting.net',
    baseUrl: 'https://www.nba-betting.net',
    fetchMethod: 'http',
    paths: {
      nba: '/predictions/',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    // Try table-based layout
    $('table.picks tr, table.predictions tr, .prediction-table tr, .game-row').each((_i, el) => {
      const $row = $(el);
      if ($row.find('th').length > 0) return; // Skip header rows

      const awayTeamRaw = $row.find('td.away-team, td:nth-child(1) .team-name').text().trim();
      const homeTeamRaw = $row.find('td.home-team, td:nth-child(2) .team-name').text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      const dateText = $row.find('td.game-date, td.date').text().trim();
      const gameDate = this.extractDate(dateText) || todayStr;

      // Spread pick
      const spreadText = $row.find('td.spread-pick, td.spread').text().trim();
      if (spreadText) {
        const spreadVal = this.parseSpreadValue(spreadText);
        const side = this.resolveSpreadSide(spreadText, awayTeamRaw, homeTeamRaw);
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
          pickerName: 'NBA-Betting.net',
          confidence: null,
          reasoning: `Spread: ${spreadText}`,
          fetchedAt,
        });
      }

      // Over/under pick
      const totalText = $row.find('td.total-pick, td.total, td.ou').text().trim();
      if (totalText) {
        const totalVal = this.parseTotalValue(totalText);
        const ouSide: Side = totalText.toLowerCase().includes('under') ? 'under' : 'over';
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime: null,
          pickType: 'over_under',
          side: ouSide,
          value: totalVal,
          pickerName: 'NBA-Betting.net',
          confidence: null,
          reasoning: `Total: ${totalText}`,
          fetchedAt,
        });
      }

      // Moneyline pick
      const mlText = $row.find('td.ml-pick, td.moneyline, td.winner').text().trim();
      if (mlText) {
        const side = this.resolveSpreadSide(mlText, awayTeamRaw, homeTeamRaw);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime: null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'NBA-Betting.net',
          confidence: null,
          reasoning: `ML: ${mlText}`,
          fetchedAt,
        });
      }
    });

    // Fallback: card-based layout
    if (predictions.length === 0) {
      $('.prediction-card, .game-card, .pick-card').each((_i, el) => {
        const $card = $(el);
        const teamEls = $card.find('.team-name, .team');
        if (teamEls.length < 2) return;

        const awayTeamRaw = $(teamEls[0]).text().trim();
        const homeTeamRaw = $(teamEls[1]).text().trim();
        if (!homeTeamRaw || !awayTeamRaw) return;

        const pickText = $card.find('.pick, .prediction, .winner').text().trim();
        const side = this.resolveSpreadSide(pickText, awayTeamRaw, homeTeamRaw);
        const confText = $card.find('.confidence, .rating').text().trim();

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: todayStr,
          gameTime: null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'NBA-Betting.net',
          confidence: this.inferConfidence(confText),
          reasoning: pickText.slice(0, 300) || null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private resolveSpreadSide(text: string, away: string, home: string): Side {
    const lower = text.toLowerCase();
    const awayLast = away.toLowerCase().split(' ').pop()!;
    const homeLast = home.toLowerCase().split(' ').pop()!;
    if (lower.includes(awayLast)) return 'away';
    if (lower.includes(homeLast)) return 'home';
    return 'home';
  }

  private extractDate(text: string): string | null {
    const match = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (!match) return null;
    const month = match[1]!.padStart(2, '0');
    const day = match[2]!.padStart(2, '0');
    const year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : String(new Date().getFullYear());
    return `${year}-${month}-${day}`;
  }
}
