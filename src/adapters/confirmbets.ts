import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * ConfirmBets adapter.
 *
 * Nigerian football tips site with prediction rows containing:
 *   - League/country badge
 *   - Home team vs Away team
 *   - Tip (1, X, 2, Over 2.5, Under 2.5, GG, NG)
 *   - Odds value
 *   - Kick-off time
 *
 * Supports both 1X2 moneyline and over/under markets.
 *
 * Layout patterns:
 *   Card-based: `.prediction-card`, `.match-card`, `.game-card`
 *   Table-based: `table.predictions tbody tr`, `table.tips-table tbody tr`
 */
export class ConfirmBetsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'confirmbets',
    name: 'ConfirmBets',
    baseUrl: 'https://www.confirmbets.com',
    fetchMethod: 'http',
    paths: {
      football: '/Predictions/Free',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Strategy 1: Card-based layout
    const cardSelectors = [
      '.prediction-card',
      '.match-card',
      '.game-card',
      '.tip-card',
      '.prediction-row',
      '.match-row',
      '.game-row',
    ];

    for (const cardSel of cardSelectors) {
      if ($(cardSel).length === 0) continue;

      $(cardSel).each((_i, el) => {
        const $card = $(el);

        const homeTeamRaw = this.extractText($card, [
          '.home-team', '.home', '.team-home', '.team-a',
          '.teams .team:first-child', 'span.home',
        ]);
        const awayTeamRaw = this.extractText($card, [
          '.away-team', '.away', '.team-away', '.team-b',
          '.teams .team:last-child', 'span.away',
        ]);
        if (!homeTeamRaw || !awayTeamRaw) return;

        const tipText = this.extractText($card, [
          '.tip', '.prediction', '.pick', '.tip-value',
          '.market', '.bet-tip', '.prediction-value',
        ]);
        if (!tipText) return;

        const league = this.extractText($card, [
          '.league', '.competition', '.league-name', '.country',
          '.tournament', '.league-badge + span',
        ]);

        const oddsText = this.extractText($card, [
          '.odds', '.odd', '.odds-value', '.price',
        ]);
        const oddsValue = oddsText ? parseFloat(oddsText.replace(/[^0-9.]/g, '')) : null;

        const timeText = this.extractText($card, [
          '.time', '.kick-off', '.kickoff', '.match-time', '.date',
        ]);
        const { gameDate, gameTime } = this.parseDateTime(timeText, fetchedAt);

        const { pickType, side, value } = this.parseTip(tipText);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType,
          side,
          value,
          pickerName: 'ConfirmBets',
          confidence: this.oddsToConfidence(oddsValue),
          reasoning: league ? `${league}` : null,
          fetchedAt,
        });
      });

      if (predictions.length > 0) return predictions;
    }

    // Strategy 2: Table-based layout
    const tableSelectors = [
      'table.predictions tbody tr',
      'table.tips-table tbody tr',
      'table.matches tbody tr',
      'table tbody tr',
    ];

    for (const tableSel of tableSelectors) {
      const rows = $(tableSel);
      if (rows.length === 0) continue;

      rows.each((_i, el) => {
        const $row = $(el);
        const cells = $row.find('td');
        if (cells.length < 4) return;

        // Try extracting teams from a single cell "Home vs Away" or separate cells
        let homeTeamRaw = '';
        let awayTeamRaw = '';
        let tipText = '';
        let league = '';
        let timeText = '';
        let oddsText = '';

        // Check for combined teams cell with "vs" or "-"
        for (let c = 0; c < cells.length; c++) {
          const cellText = $(cells[c]).text().trim();
          if (cellText.includes(' vs ') || cellText.includes(' - ') || cellText.includes(' v ')) {
            const separator = cellText.includes(' vs ') ? ' vs '
              : cellText.includes(' v ') ? ' v '
              : ' - ';
            const parts = cellText.split(separator);
            if (parts.length >= 2) {
              homeTeamRaw = parts[0]!.trim();
              awayTeamRaw = parts.slice(1).join(separator).trim();
            }
            break;
          }
        }

        // If no combined cell, try positional extraction
        if (!homeTeamRaw || !awayTeamRaw) {
          if (cells.length >= 6) {
            // Layout: time | league | home | away | tip | odds
            timeText = $(cells[0]).text().trim();
            league = $(cells[1]).text().trim();
            homeTeamRaw = $(cells[2]).text().trim();
            awayTeamRaw = $(cells[3]).text().trim();
            tipText = $(cells[4]).text().trim();
            oddsText = cells.length >= 6 ? $(cells[5]).text().trim() : '';
          } else if (cells.length >= 4) {
            // Compact: home | away | tip | odds
            homeTeamRaw = $(cells[0]).text().trim();
            awayTeamRaw = $(cells[1]).text().trim();
            tipText = $(cells[2]).text().trim();
            oddsText = $(cells[3]).text().trim();
          }
        }

        if (!homeTeamRaw || !awayTeamRaw) return;

        // If tip wasn't set from positional, try extracting from known cells
        if (!tipText) {
          tipText = this.extractText($row, [
            'td.tip', 'td.prediction', 'td.pick', 'td.market',
          ]);
        }
        if (!tipText) return;

        if (!league) {
          league = this.extractText($row, [
            'td.league', 'td.competition', '.league',
          ]);
        }

        if (!timeText) {
          timeText = this.extractText($row, [
            'td.time', 'td.date', 'td.kickoff',
          ]);
        }

        const { gameDate, gameTime } = this.parseDateTime(timeText, fetchedAt);
        const { pickType, side, value } = this.parseTip(tipText);
        const oddsValue = oddsText ? parseFloat(oddsText.replace(/[^0-9.]/g, '')) : null;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType,
          side,
          value,
          pickerName: 'ConfirmBets',
          confidence: this.oddsToConfidence(oddsValue),
          reasoning: league ? `${league}` : null,
          fetchedAt,
        });
      });

      if (predictions.length > 0) break;
    }

    return predictions;
  }

  private extractText(
    $el: ReturnType<ReturnType<typeof this.load>>,
    selectors: string[],
  ): string {
    for (const sel of selectors) {
      const text = $el.find(sel).first().text().trim();
      if (text) return text;
    }
    return '';
  }

  private parseTip(tip: string): {
    pickType: RawPrediction['pickType'];
    side: Side;
    value: number | null;
  } {
    const lower = tip.toLowerCase().trim();

    // Over/Under
    const ouMatch = lower.match(/^(over|under)\s*([\d.]+)/);
    if (ouMatch) {
      return {
        pickType: 'over_under',
        side: ouMatch[1] as Side,
        value: parseFloat(ouMatch[2]!),
      };
    }

    // BTTS
    if (lower === 'gg' || lower === 'btts' || lower === 'btts yes') {
      return { pickType: 'prop', side: 'yes', value: null };
    }
    if (lower === 'ng' || lower === 'btts no') {
      return { pickType: 'prop', side: 'no', value: null };
    }

    // 1X2 mapping
    const side = this.tipToSide(lower);
    return { pickType: 'moneyline', side, value: null };
  }

  private tipToSide(tip: string): Side {
    switch (tip) {
      case '1':
      case 'h':
      case 'home':
      case 'home win':
      case '1x':
        return 'home';
      case '2':
      case 'a':
      case 'away':
      case 'away win':
      case 'x2':
        return 'away';
      case 'x':
      case 'd':
      case 'draw':
        return 'draw';
      default:
        return 'home';
    }
  }

  private oddsToConfidence(odds: number | null): Confidence | null {
    if (odds === null || isNaN(odds)) return null;
    if (odds <= 1.3) return 'best_bet';
    if (odds <= 1.6) return 'high';
    if (odds <= 2.2) return 'medium';
    return 'low';
  }

  private parseDateTime(
    text: string,
    fetchedAt: Date,
  ): { gameDate: string; gameTime: string | null } {
    if (!text) {
      return { gameDate: fetchedAt.toISOString().split('T')[0]!, gameTime: null };
    }

    // DD/MM/YYYY HH:MM
    const full = text.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s+(\d{1,2}:\d{2})/);
    if (full) {
      const day = full[1]!.padStart(2, '0');
      const month = full[2]!.padStart(2, '0');
      return { gameDate: `${full[3]}-${month}-${day}`, gameTime: full[4]! };
    }

    // DD/MM/YYYY
    const dateOnly = text.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
    if (dateOnly) {
      const day = dateOnly[1]!.padStart(2, '0');
      const month = dateOnly[2]!.padStart(2, '0');
      return { gameDate: `${dateOnly[3]}-${month}-${day}`, gameTime: null };
    }

    // Time only HH:MM
    const timeOnly = text.match(/(\d{1,2}:\d{2})/);
    return {
      gameDate: fetchedAt.toISOString().split('T')[0]!,
      gameTime: timeOnly ? timeOnly[1]! : null,
    };
  }
}
