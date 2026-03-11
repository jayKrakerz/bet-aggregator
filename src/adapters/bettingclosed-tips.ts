import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * BettingClosed Tips adapter.
 *
 * Football predictions site with table or card layout:
 *   - Match info: home team, away team, league
 *   - Prediction: 1X2, over/under, BTTS
 *   - Confidence/probability score as percentage or stars
 *   - Kick-off time
 *
 * Layout patterns:
 *   Card: `.prediction-card`, `.match-card`, `.fixture`
 *   Table: `table.predictions tr`, `.prediction-table tr`
 */
export class BettingClosedTipsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'bettingclosed-tips',
    name: 'BettingClosed Tips',
    baseUrl: 'https://www.bettingclosed.com',
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

    // Strategy 1: Card-based layout
    const cardSelectors = [
      '.prediction-card',
      '.match-card',
      '.fixture',
      '.tip-card',
      '.match-item',
      '.prediction-item',
      '.event-row',
      '.match-row',
    ];

    for (const cardSel of cardSelectors) {
      if ($(cardSel).length === 0) continue;

      $(cardSel).each((_i, el) => {
        const $card = $(el);

        const homeTeamRaw = this.extractText($card, [
          '.home-team', '.home', '.team-home', '.team-a',
          '.team:first-child', 'span.home', '.teams .home',
        ]);
        const awayTeamRaw = this.extractText($card, [
          '.away-team', '.away', '.team-away', '.team-b',
          '.team:last-child', 'span.away', '.teams .away',
        ]);
        if (!homeTeamRaw || !awayTeamRaw) return;

        const tipText = this.extractText($card, [
          '.prediction', '.tip', '.pick', '.prediction-value',
          '.bet-tip', '.recommended', '.market-tip',
        ]);
        if (!tipText) return;

        const league = this.extractText($card, [
          '.league', '.league-name', '.competition', '.tournament',
          '.country', '.event-league',
        ]);

        const confText = this.extractText($card, [
          '.confidence', '.probability', '.score', '.rating',
          '.percentage', '.chance', '.confidence-score',
        ]);
        const confidence = this.parseConfidenceScore(confText);

        const timeText = this.extractText($card, [
          '.time', '.date', '.kick-off', '.kickoff',
          '.match-time', '.match-date', '.event-date',
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
          pickerName: 'BettingClosed',
          confidence,
          reasoning: league ? `${league}` : null,
          fetchedAt,
        });
      });

      if (predictions.length > 0) return predictions;
    }

    // Strategy 2: Table-based layout
    const tableSelectors = [
      'table.predictions tbody tr',
      'table.prediction-table tbody tr',
      '.prediction-table tbody tr',
      'table.tips tbody tr',
      'table tbody tr',
    ];

    for (const tableSel of tableSelectors) {
      const rows = $(tableSel);
      if (rows.length === 0) continue;

      rows.each((_i, el) => {
        const $row = $(el);
        const cells = $row.find('td');
        if (cells.length < 3) return;

        let homeTeamRaw = '';
        let awayTeamRaw = '';
        let tipText = '';
        let league = '';
        let confText = '';
        let timeText = '';

        // Try "Home vs Away" in a single cell
        for (let c = 0; c < cells.length; c++) {
          const cellText = $(cells[c]).text().trim();
          const sepMatch = cellText.match(/^(.+?)\s+(?:vs?\.?|[-])\s+(.+)$/i);
          if (sepMatch && sepMatch[1] && sepMatch[2]) {
            homeTeamRaw = sepMatch[1].trim();
            awayTeamRaw = sepMatch[2].trim();
            break;
          }
        }

        // Positional fallback
        if (!homeTeamRaw || !awayTeamRaw) {
          if (cells.length >= 6) {
            timeText = $(cells[0]).text().trim();
            league = $(cells[1]).text().trim();
            homeTeamRaw = $(cells[2]).text().trim();
            awayTeamRaw = $(cells[3]).text().trim();
            tipText = $(cells[4]).text().trim();
            confText = cells.length >= 6 ? $(cells[5]).text().trim() : '';
          } else if (cells.length >= 4) {
            homeTeamRaw = $(cells[0]).text().trim();
            awayTeamRaw = $(cells[1]).text().trim();
            tipText = $(cells[2]).text().trim();
            confText = $(cells[3]).text().trim();
          } else if (cells.length >= 3) {
            homeTeamRaw = $(cells[0]).text().trim();
            awayTeamRaw = $(cells[1]).text().trim();
            tipText = $(cells[2]).text().trim();
          }
        }

        if (!homeTeamRaw || !awayTeamRaw) return;

        if (!tipText) {
          tipText = this.extractText($row, [
            'td.tip', 'td.prediction', 'td.pick',
          ]);
        }
        if (!tipText) return;

        if (!confText) {
          confText = this.extractText($row, [
            'td.confidence', 'td.score', 'td.probability',
          ]);
        }

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
        const confidence = this.parseConfidenceScore(confText);

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
          pickerName: 'BettingClosed',
          confidence,
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

    // 1X2
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

  private parseConfidenceScore(text: string): Confidence | null {
    if (!text) return null;

    // Percentage-based: "85%", "85 %"
    const pctMatch = text.match(/([\d.]+)\s*%/);
    if (pctMatch) {
      const pct = parseFloat(pctMatch[1]!);
      if (isNaN(pct)) return null;
      if (pct >= 75) return 'best_bet';
      if (pct >= 60) return 'high';
      if (pct >= 45) return 'medium';
      return 'low';
    }

    // Star-based: count star characters or "/5"
    const starMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (starMatch) {
      const score = parseInt(starMatch[1]!, 10);
      const max = parseInt(starMatch[2]!, 10);
      if (max > 0) {
        const ratio = score / max;
        if (ratio >= 0.8) return 'best_bet';
        if (ratio >= 0.6) return 'high';
        if (ratio >= 0.4) return 'medium';
        return 'low';
      }
    }

    // Numeric only: "4.2"
    const numMatch = text.match(/([\d.]+)/);
    if (numMatch) {
      const num = parseFloat(numMatch[1]!);
      if (!isNaN(num) && num <= 10) {
        if (num >= 8) return 'best_bet';
        if (num >= 6) return 'high';
        if (num >= 4) return 'medium';
        return 'low';
      }
    }

    return this.inferConfidence(text);
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

    // Time only
    const timeOnly = text.match(/(\d{1,2}:\d{2})/);
    return {
      gameDate: fetchedAt.toISOString().split('T')[0]!,
      gameTime: timeOnly ? timeOnly[1]! : null,
    };
  }
}
