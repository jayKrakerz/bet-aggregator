import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Supatips adapter.
 *
 * Server-rendered HTML tables. Each match in `div.match-row`:
 *   .teams .team-name:nth-child(1)  - home team
 *   .teams .team-name:nth-child(2)  - away team
 *   .teams .match-time              - "DD/MM/YYYY HH:MM"
 *   .pred-cell .pred-badge          - prediction: "1", "X", or "2"
 *   .pred-cell .pred-pct            - confidence: "80%"
 *   .goals-cell                     - "Un2.5" or "Ov2.5"
 *   .odds-cell[data-odds-type] .odds-box - decimal odds
 *
 * League context from preceding div.league-row via data-league attr.
 * Hidden matches (fixture-hidden class) are still in HTML.
 */
export class SupatipsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'supatips',
    name: 'Supatips',
    baseUrl: 'https://www.supatips.com',
    fetchMethod: 'http',
    paths: {
      football: '/today-predictions',
    },
    cron: '0 0 6,10,14,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Build league map from league-row elements
    const leagues = new Map<string, string>();
    $('div.league-row').each((_i, el) => {
      const $row = $(el);
      const id = $row.attr('data-league') || '';
      const country = $row.find('.league-country').text().replace(':', '').trim();
      const name = $row.find('.league-name').text().trim();
      leagues.set(id, `${country} ${name}`.trim());
    });

    $('div.match-row').each((_i, el) => {
      const $match = $(el);

      const home = $match.find('.teams .team-name:nth-child(1)').text().trim();
      const away = $match.find('.teams .team-name:nth-child(2)').text().trim();
      if (!home || !away) return;

      // Date/time: "DD/MM/YYYY HH:MM"
      const timeText = $match.find('.teams .match-time').text().trim();
      const gameDate = this.parseDateTime(timeText);

      // Prediction: "1", "X", or "2"
      const predBadge = $match.find('.pred-cell .pred-badge').text().trim();
      if (!predBadge) return;

      // Confidence: "80%"
      const confText = $match.find('.pred-cell .pred-pct').text().trim();
      const confNum = parseInt(confText, 10);
      const confidence: Confidence | null = confNum >= 70 ? 'high' : confNum >= 50 ? 'medium' : 'low';

      // Goals market: "Un2.5" or "Ov2.5"
      const goalsText = $match.find('.goals-cell').text().trim();

      // League context
      const leagueId = $match.attr('data-league') || '';
      const league = leagues.get(leagueId) || '';

      // Map 1X2 prediction to side
      const side = this.predToSide(predBadge);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: home,
        awayTeamRaw: away,
        gameDate: gameDate || fetchedAt.toISOString().split('T')[0]!,
        gameTime: timeText || null,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'Supatips',
        confidence,
        reasoning: `${predBadge} (${confText})${goalsText ? ` | Goals: ${goalsText}` : ''}${league ? ` | ${league}` : ''}`,
        fetchedAt,
      });

      // Also add over/under prediction if present
      if (goalsText) {
        const ouMatch = goalsText.match(/(Un|Ov)([\d.]+)/i);
        if (ouMatch) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: home,
            awayTeamRaw: away,
            gameDate: gameDate || fetchedAt.toISOString().split('T')[0]!,
            gameTime: timeText || null,
            pickType: 'over_under',
            side: ouMatch[1]!.toLowerCase().startsWith('ov') ? 'over' : 'under',
            value: parseFloat(ouMatch[2]!),
            pickerName: 'Supatips',
            confidence: 'medium',
            reasoning: `Goals: ${goalsText}${league ? ` | ${league}` : ''}`,
            fetchedAt,
          });
        }
      }
    });

    return predictions;
  }

  private predToSide(pred: string): Side {
    if (pred === '1') return 'home';
    if (pred === '2') return 'away';
    return 'draw';
  }

  private parseDateTime(text: string): string | null {
    // "DD/MM/YYYY HH:MM"
    const match = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) return null;
    return `${match[3]}-${match[2]}-${match[1]}`;
  }
}
