import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * BettingClosed adapter.
 *
 * STATUS: BROKEN - /football-predictions/ returns 404 as of 2026-03-10.
 * The site may have restructured or shut down. Needs URL discovery.
 *
 * Bettingclosed.com provides football match predictions with probabilities.
 *
 * Expected page structure:
 * - Predictions grouped by league under `.league-group` or `section.league`
 * - Each league has a header with league name and country flag
 * - Match rows in `table tbody tr` or `.match-prediction` cards
 * - Columns: Time | Home | Prob 1 | Prob X | Prob 2 | Away | Tip | Score
 * - Tips shown as highlighted cell or bold text in 1/X/2 format
 * - Probabilities as percentages in colored cells (green=likely, red=unlikely)
 *
 * The site is fairly standard server-rendered HTML with jQuery.
 */
export class BettingclosedAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'bettingclosed',
    name: 'BettingClosed',
    baseUrl: 'https://www.bettingclosed.com',
    fetchMethod: 'http',
    paths: {
      football: '/football-predictions/',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentLeague = '';

    // Process league groups
    $('.league-group, section.league, .competition-block').each((_i, groupEl) => {
      const $group = $(groupEl);
      currentLeague = $group.find('.league-name, h3, h4, .league-title').first().text().trim();

      $group.find('table tbody tr, .match-prediction, .match-row').each((_j, rowEl) => {
        const $row = $(rowEl);
        const pred = this.parseRow($, $row, sport, fetchedAt, currentLeague);
        if (pred) predictions.push(pred);
      });
    });

    // Fallback: flat table without league grouping
    if (predictions.length === 0) {
      $('table tbody tr').each((_i, el) => {
        const $row = $(el);

        // Check for league header rows
        if ($row.find('td').length <= 2) {
          currentLeague = $row.text().trim();
          return;
        }

        const pred = this.parseRow($, $row, sport, fetchedAt, currentLeague);
        if (pred) predictions.push(pred);
      });
    }

    return predictions;
  }

  private parseRow(
    $: ReturnType<typeof this.load>,
    $row: ReturnType<ReturnType<typeof this.load>>,
    sport: string,
    fetchedAt: Date,
    league: string,
  ): RawPrediction | null {
    const cells = $row.find('td');
    if (cells.length < 5) return null;

    // Try standard layout: Time | Home | 1 | X | 2 | Away | Tip
    const texts = cells.map((_j, cell) => $(cell).text().trim()).get();

    // Find team names (longest non-numeric cells)
    const teamCandidates: { index: number; text: string }[] = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i]!;
      if (t.length > 2 && !/^\d+[%]?$/.test(t) && !/^\d{1,2}:\d{2}$/.test(t) && !this.isTipCode(t)) {
        teamCandidates.push({ index: i, text: t });
      }
    }
    if (teamCandidates.length < 2) return null;

    const homeTeam = teamCandidates[0]!.text;
    const awayTeam = teamCandidates[1]!.text;

    // Extract probabilities (3 consecutive percentage-like numbers)
    const probs: number[] = [];
    for (const t of texts) {
      const num = parseInt(t.replace('%', ''), 10);
      if (!isNaN(num) && num >= 0 && num <= 100 && t.replace('%', '').length <= 3) {
        probs.push(num);
      }
    }

    // Find tip
    let tip = '';
    // Check for highlighted/bold cell
    const highlighted = $row.find('td.highlight, td strong, td b, td.active, td.selected');
    if (highlighted.length) {
      tip = highlighted.first().text().trim();
    }
    if (!this.isTipCode(tip)) {
      for (const t of texts) {
        if (this.isTipCode(t)) { tip = t; break; }
      }
    }

    const side = this.mapTipToSide(tip);
    if (!side) return null;

    // Extract time
    let gameTime: string | null = null;
    for (const t of texts) {
      if (/^\d{1,2}:\d{2}$/.test(t)) { gameTime = t; break; }
    }

    const confidence = this.probsToConfidence(probs, side);

    return {
      sourceId: this.config.id,
      sport,
      homeTeamRaw: homeTeam,
      awayTeamRaw: awayTeam,
      gameDate: fetchedAt.toISOString().split('T')[0]!,
      gameTime,
      pickType: 'moneyline',
      side,
      value: null,
      pickerName: 'BettingClosed',
      confidence,
      reasoning: [
        league,
        probs.length >= 3 ? `Prob: ${probs[0]}/${probs[1]}/${probs[2]}` : '',
      ].filter(Boolean).join(' | ') || null,
      fetchedAt,
    };
  }

  private isTipCode(text: string): boolean {
    const t = text.toUpperCase().trim();
    return ['1', '2', 'X', '1X', 'X2', '12'].includes(t);
  }

  private mapTipToSide(tip: string): Side | null {
    const t = tip.toUpperCase().trim();
    if (t === '1') return 'home';
    if (t === '2') return 'away';
    if (t === 'X') return 'draw';
    if (t === '1X') return 'home';
    if (t === 'X2') return 'away';
    return null;
  }

  private probsToConfidence(probs: number[], side: Side): Confidence | null {
    if (probs.length < 3) return null;
    let prob: number;
    if (side === 'home') prob = probs[0]!;
    else if (side === 'draw') prob = probs[1]!;
    else prob = probs[2]!;

    if (prob >= 70) return 'best_bet';
    if (prob >= 55) return 'high';
    if (prob >= 40) return 'medium';
    return 'low';
  }
}
