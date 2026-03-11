import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * BetLoy adapter (formerly Soccer24x7).
 *
 * Scrapes soccer predictions from betloy.com/predictions.
 * The site uses a table-based layout with:
 *   - `<thead class="league_title">` for league headers
 *   - `<tbody>` containing `<tr class="match-row">` entries
 *   - Each match-row has data attributes: data-match-id, data-league-id, data-odds
 *   - Teams in `<td class="match-info">` with `<span class="club-name">` elements
 *   - Tips in `<td class="match-act">` with `<a class="tips active">` for selected tip
 *   - Odds in `<span class="selected-value">`
 *   - Additional info in `.top-info` and `.bottom-info` spans
 *   - Time/score in `.meta`, `.side`, `.score` elements
 */
export class Soccer24x7Adapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'betloy',
    name: 'BetLoy',
    baseUrl: 'https://www.betloy.com',
    fetchMethod: 'http',
    paths: {
      football: '/predictions',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Strategy 1: BetLoy's known structure
    // League headers are in <thead class="league_title">
    // Match rows are in <tbody> > <tr class="match-row">
    let currentLeague = '';

    // Iterate through all table sections
    $('thead.league_title, tr.match-row').each((_i, el) => {
      const $el = $(el);

      // League header
      if ($el.is('thead.league_title') || $el.hasClass('league_title')) {
        currentLeague = $el.text().trim();
        return;
      }

      // Match row
      if ($el.hasClass('match-row')) {
        const $row = $el;

        // Extract teams from .club-name spans inside .match-info
        const clubNames = $row.find('.club-name');
        const homeTeam = clubNames.eq(0).text().trim();
        const awayTeam = clubNames.eq(1).text().trim();

        if (!homeTeam || !awayTeam) return;

        // Extract the active tip
        const tipText = $row.find('.tips.active, a.tips.active, .tips a.active').first().text().trim();

        // Extract odds from selected-value or data-odds attribute
        const oddsText = $row.find('.selected-value').first().text().trim();
        const dataOdds = $row.attr('data-odds') || '';
        const odds = parseFloat(oddsText) || parseFloat(dataOdds) || null;

        // Extract time from .meta or .top-info
        const timeText =
          $row.find('.meta').first().text().trim() ||
          $row.find('.top-info').first().text().trim();

        const side = this.mapTipToSide(tipText);
        if (!side) return;

        const isOverUnder = this.isOverUnderTip(tipText);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate: today,
          gameTime: this.extractTime(timeText),
          pickType: isOverUnder ? 'over_under' : this.isBtts(tipText) ? 'prop' : 'moneyline',
          side,
          value: isOverUnder ? (this.parseTotalValue(tipText) ?? 2.5) : null,
          pickerName: 'BetLoy',
          confidence: odds ? this.oddsToConfidence(odds) : null,
          reasoning: currentLeague || null,
          fetchedAt,
        });
      }
    });

    if (predictions.length > 0) return predictions;

    // Strategy 2: Fallback for alternative DOM structures
    // Try looking for league titles in any thead, match data in tbody tr
    $('table').each((_i, tableEl) => {
      const $table = $(tableEl);

      $table.find('thead').each((_j, theadEl) => {
        const leagueText = $(theadEl).text().trim();
        if (leagueText) currentLeague = leagueText;
      });

      $table.find('tbody tr').each((_j, rowEl) => {
        const $row = $(rowEl);

        // Try club-name spans
        let homeTeam = '';
        let awayTeam = '';

        const clubNames = $row.find('.club-name, .team-name, .team');
        if (clubNames.length >= 2) {
          homeTeam = clubNames.eq(0).text().trim();
          awayTeam = clubNames.eq(1).text().trim();
        }

        // Fallback: cell-based extraction
        if (!homeTeam || !awayTeam) {
          const cells = $row.find('td');
          if (cells.length < 3) return;

          // Try to find teams in cells
          for (let c = 0; c < cells.length; c++) {
            const cellText = $(cells[c]).text().trim();
            const vsMatch = cellText.match(/^(.+?)\s+(?:vs?\.?|[-–])\s+(.+)$/i);
            if (vsMatch && vsMatch[1] && vsMatch[2]) {
              homeTeam = vsMatch[1].trim();
              awayTeam = vsMatch[2].trim();
              break;
            }
          }

          if (!homeTeam || !awayTeam) {
            if (cells.length >= 4) {
              homeTeam = cells.eq(0).text().trim();
              awayTeam = cells.eq(1).text().trim();
            }
          }
        }

        if (!homeTeam || !awayTeam) return;

        const tipText =
          $row.find('.tips.active, a.tips.active, .tip, .prediction, .pick').first().text().trim();
        const oddsText =
          $row.find('.selected-value, .odds, .odd').first().text().trim();
        const odds = parseFloat(oddsText) || null;

        const side = this.mapTipToSide(tipText);
        if (!side) return;

        const isOverUnder = this.isOverUnderTip(tipText);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate: today,
          gameTime: null,
          pickType: isOverUnder ? 'over_under' : this.isBtts(tipText) ? 'prop' : 'moneyline',
          side,
          value: isOverUnder ? (this.parseTotalValue(tipText) ?? 2.5) : null,
          pickerName: 'BetLoy',
          confidence: odds ? this.oddsToConfidence(odds) : null,
          reasoning: currentLeague || null,
          fetchedAt,
        });
      });
    });

    return predictions;
  }

  private mapTipToSide(tip: string): Side | null {
    const t = tip.toUpperCase().trim();
    if (t === '1' || t === 'H' || t === 'HOME' || t === 'HOME WIN' || t === '1X') return 'home';
    if (t === '2' || t === 'A' || t === 'AWAY' || t === 'AWAY WIN' || t === 'X2') return 'away';
    if (t === 'X' || t === 'D' || t === 'DRAW') return 'draw';
    if (t.startsWith('OVER') || t === 'OV' || /^O\d/.test(t)) return 'over';
    if (t.startsWith('UNDER') || t === 'UN' || /^U\d/.test(t)) return 'under';
    if (t === 'GG' || t === 'BTTS' || t === 'BTTS YES' || t === 'YES') return 'yes';
    if (t === 'NG' || t === 'BTTS NO' || t === 'NO') return 'no';
    return null;
  }

  private isOverUnderTip(tip: string): boolean {
    const t = tip.toUpperCase().trim();
    return t.startsWith('OVER') || t.startsWith('UNDER') ||
      t === 'OV' || t === 'UN' || /^[OU]\d/.test(t);
  }

  private isBtts(tip: string): boolean {
    const t = tip.toUpperCase().trim();
    return t === 'GG' || t === 'NG' || t.startsWith('BTTS');
  }

  private oddsToConfidence(odds: number): Confidence | null {
    if (odds <= 0) return null;
    const impliedProb = 1 / odds;
    if (impliedProb >= 0.75) return 'best_bet';
    if (impliedProb >= 0.55) return 'high';
    if (impliedProb >= 0.35) return 'medium';
    return 'low';
  }

  private extractTime(text: string): string | null {
    if (!text) return null;
    const match = text.match(/(\d{1,2}:\d{2})/);
    return match ? match[1]! : null;
  }
}
