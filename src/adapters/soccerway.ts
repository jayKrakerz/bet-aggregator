import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Soccerway adapter.
 *
 * STATUS: BROKEN - /predictions/ returns a server error page as of 2026-03-10.
 * The site may not have a public predictions endpoint. Needs URL discovery.
 *
 * Soccerway.com is a comprehensive soccer results and fixtures site.
 * The predictions section shows upcoming matches with implied picks
 * based on team form, head-to-head records, and statistical models.
 *
 * Expected page structure:
 * - Matches grouped by competition in `table.matches` or `.competition-block`
 * - Competition headers: `th.competition-link` or `.competition-name`
 * - Match rows: `tr.match` with data attributes
 * - Each row contains:
 *   - `td.date`: match date (DD/MM/YYYY)
 *   - `td.team-a`: home team name (in `a` tag)
 *   - `td.score-time`: kickoff time or "vs"
 *   - `td.team-b`: away team name (in `a` tag)
 *   - `td.prediction` or data attributes: prediction info
 *
 * Soccerway may also provide predictions in a sidebar or dedicated section
 * using `.prediction-widget` containers.
 */
export class SoccerwayAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'soccerway',
    name: 'Soccerway',
    baseUrl: 'https://www.soccerway.com',
    fetchMethod: 'http',
    paths: {
      football: '/predictions/',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentLeague = '';

    // Primary: competition blocks with match tables
    $('table.matches, .competition-block').each((_i, tableEl) => {
      const $table = $(tableEl);

      $table.find('tr').each((_j, rowEl) => {
        const $row = $(rowEl);

        // Competition header
        if ($row.find('th.competition-link, th.competition-name, .competition-name').length) {
          currentLeague = $row.find('th.competition-link, th.competition-name, .competition-name').text().trim();
          return;
        }

        // Match rows
        if (!$row.hasClass('match') && !$row.find('td.team-a').length) return;

        const homeTeam = $row.find('td.team-a a, td.team-a, .home-team').text().trim();
        const awayTeam = $row.find('td.team-b a, td.team-b, .away-team').text().trim();
        if (!homeTeam || !awayTeam) return;

        const dateText = $row.find('td.date, .match-date').text().trim();
        const timeText = $row.find('td.score-time, .match-time').text().trim();

        // Look for prediction data
        const tipText = $row.find('td.prediction, .prediction, [data-prediction]').text().trim()
          || $row.attr('data-prediction') || '';
        const side = this.mapTipToSide(tipText);
        if (!side) return;

        // Probability data attributes
        const probHome = parseFloat($row.attr('data-prob-1') || $row.find('[data-prob-1]').attr('data-prob-1') || '');
        const probDraw = parseFloat($row.attr('data-prob-x') || $row.find('[data-prob-x]').attr('data-prob-x') || '');
        const probAway = parseFloat($row.attr('data-prob-2') || $row.find('[data-prob-2]').attr('data-prob-2') || '');

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate: this.extractDate(dateText, fetchedAt),
          gameTime: /\d{1,2}:\d{2}/.test(timeText) ? timeText : null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'Soccerway',
          confidence: this.probsToConfidence(probHome, probDraw, probAway, side),
          reasoning: [
            currentLeague,
            !isNaN(probHome) ? `Prob: ${Math.round(probHome * 100)}/${Math.round(probDraw * 100)}/${Math.round(probAway * 100)}` : '',
          ].filter(Boolean).join(' | ') || null,
          fetchedAt,
        });
      });
    });

    // Fallback: prediction widget
    if (predictions.length === 0) {
      $('.prediction-widget .prediction-item, .prediction-card').each((_i, el) => {
        const $el = $(el);
        const homeTeam = $el.find('.home, .team-a').text().trim();
        const awayTeam = $el.find('.away, .team-b').text().trim();
        if (!homeTeam || !awayTeam) return;

        const tip = $el.find('.tip, .prediction, .pick').text().trim();
        const side = this.mapTipToSide(tip);
        if (!side) return;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate: fetchedAt.toISOString().split('T')[0]!,
          gameTime: null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'Soccerway',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private mapTipToSide(tip: string): Side | null {
    const t = tip.toUpperCase().trim();
    if (t === '1' || t === 'HOME' || t.includes('HOME WIN')) return 'home';
    if (t === '2' || t === 'AWAY' || t.includes('AWAY WIN')) return 'away';
    if (t === 'X' || t === 'DRAW' || t.includes('DRAW')) return 'draw';
    if (t === '1X') return 'home';
    if (t === 'X2') return 'away';
    return null;
  }

  private probsToConfidence(p1: number, pX: number, p2: number, side: Side): Confidence | null {
    if (isNaN(p1) || isNaN(pX) || isNaN(p2)) return null;
    // Probabilities might be 0-1 or 0-100
    let prob: number;
    if (side === 'home') prob = p1;
    else if (side === 'draw') prob = pX;
    else prob = p2;

    // Normalize to 0-100 if in 0-1 range
    if (prob <= 1) prob *= 100;

    if (prob >= 70) return 'best_bet';
    if (prob >= 55) return 'high';
    if (prob >= 40) return 'medium';
    return 'low';
  }

  private extractDate(text: string, fetchedAt: Date): string {
    const match = text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (match) {
      const day = match[1]!.padStart(2, '0');
      const month = match[2]!.padStart(2, '0');
      const year = match[3]!.length === 2 ? `20${match[3]}` : match[3]!;
      return `${year}-${month}-${day}`;
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
