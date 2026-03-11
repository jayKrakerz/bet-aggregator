import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * SoccerPredictions365 adapter.
 *
 * Standard soccer prediction site with table-based layout:
 *   - League grouping headers
 *   - Match rows: home team, away team, tip, confidence/probability
 *   - Tips: 1X2, Over/Under 2.5, BTTS
 *   - Confidence as percentage or text label
 *
 * Layout patterns:
 *   Table: `table.prediction-table tr`, `table tbody tr`
 *   Card: `.prediction-card`, `.match-card`, `.fixture-card`
 *   Grouped: `.league-section` containing match rows
 */
export class SoccerPredictions365Adapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'soccerpredictions365',
    name: 'SoccerPredictions365',
    baseUrl: 'https://www.soccerpredictions365.com',
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

    // Strategy 1: Grouped league sections with match rows
    const sectionSelectors = [
      '.league-section',
      '.league-group',
      '.competition-section',
      '.league-block',
    ];

    for (const secSel of sectionSelectors) {
      if ($(secSel).length === 0) continue;

      $(secSel).each((_i, secEl) => {
        const $section = $(secEl);
        const league = this.extractText($section, [
          '.league-title', '.league-name', '.section-title',
          '.competition-name', 'h2', 'h3', '.header',
        ]);

        const matchRows = $section.find('.match-row, .prediction-row, .fixture, .match-item, tr');
        matchRows.each((_j, rowEl) => {
          const $row = $(rowEl);
          const pred = this.parseMatchRow($, $row, sport, league, fetchedAt);
          if (pred) predictions.push(...pred);
        });
      });

      if (predictions.length > 0) return predictions;
    }

    // Strategy 2: Card-based layout
    const cardSelectors = [
      '.prediction-card',
      '.match-card',
      '.fixture-card',
      '.tip-card',
      '.game-card',
      '.match-item',
      '.prediction-item',
      '.event-row',
    ];

    for (const cardSel of cardSelectors) {
      if ($(cardSel).length === 0) continue;

      $(cardSel).each((_i, el) => {
        const $card = $(el);

        const homeTeamRaw = this.extractText($card, [
          '.home-team', '.home', '.team-home', '.team-a',
          '.team:first-child', 'span.home',
        ]);
        const awayTeamRaw = this.extractText($card, [
          '.away-team', '.away', '.team-away', '.team-b',
          '.team:last-child', 'span.away',
        ]);
        if (!homeTeamRaw || !awayTeamRaw) return;

        const tipText = this.extractText($card, [
          '.tip', '.prediction', '.pick', '.market',
          '.prediction-value', '.bet-tip', '.recommended',
        ]);
        if (!tipText) return;

        const league = this.extractText($card, [
          '.league', '.league-name', '.competition', '.tournament',
          '.country', '.event-league',
        ]);

        const confText = this.extractText($card, [
          '.confidence', '.probability', '.chance', '.percentage',
          '.score', '.rating',
        ]);

        const timeText = this.extractText($card, [
          '.time', '.date', '.kick-off', '.kickoff',
          '.match-time', '.match-date',
        ]);
        const { gameDate, gameTime } = this.parseDateTime(timeText, fetchedAt);
        const { pickType, side, value } = this.parseTip(tipText);
        const confidence = this.parseConfidenceText(confText);

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
          pickerName: 'SoccerPredictions365',
          confidence,
          reasoning: league || null,
          fetchedAt,
        });
      });

      if (predictions.length > 0) return predictions;
    }

    // Strategy 3: Plain table layout
    const tableSelectors = [
      'table.prediction-table tbody tr',
      'table.predictions tbody tr',
      'table.tips tbody tr',
      'table.matches tbody tr',
      'table tbody tr',
    ];

    let currentLeague = '';

    for (const tableSel of tableSelectors) {
      const rows = $(tableSel);
      if (rows.length === 0) continue;

      rows.each((_i, el) => {
        const $row = $(el);
        const cells = $row.find('td');

        // League header row (single cell spanning full width)
        if (cells.length === 1) {
          const headerText = $(cells[0]).text().trim();
          if (headerText) currentLeague = headerText;
          return;
        }

        if (cells.length < 3) return;

        let homeTeamRaw = '';
        let awayTeamRaw = '';
        let tipText = '';
        let confText = '';
        let timeText = '';

        // Try combined teams cell
        for (let c = 0; c < Math.min(cells.length, 4); c++) {
          const cellText = $(cells[c]).text().trim();
          const sepMatch = cellText.match(/^(.+?)\s+(?:vs?\.?|[-])\s+(.+)$/i);
          if (sepMatch && sepMatch[1] && sepMatch[2]) {
            homeTeamRaw = sepMatch[1].trim();
            awayTeamRaw = sepMatch[2].trim();
            break;
          }
        }

        if (!homeTeamRaw || !awayTeamRaw) {
          if (cells.length >= 6) {
            // Layout: time | league | home | away | tip | confidence
            timeText = $(cells[0]).text().trim();
            const possibleLeague = $(cells[1]).text().trim();
            if (possibleLeague) currentLeague = possibleLeague;
            homeTeamRaw = $(cells[2]).text().trim();
            awayTeamRaw = $(cells[3]).text().trim();
            tipText = $(cells[4]).text().trim();
            confText = $(cells[5]).text().trim();
          } else if (cells.length >= 5) {
            // Layout: home | away | tip | confidence | league
            homeTeamRaw = $(cells[0]).text().trim();
            awayTeamRaw = $(cells[1]).text().trim();
            tipText = $(cells[2]).text().trim();
            confText = $(cells[3]).text().trim();
            const possibleLeague = $(cells[4]).text().trim();
            if (possibleLeague) currentLeague = possibleLeague;
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
            'td.tip', 'td.prediction', 'td.pick', 'td.market',
          ]);
        }
        if (!tipText) return;

        if (!timeText) {
          timeText = this.extractText($row, [
            'td.time', 'td.date', 'td.kickoff',
          ]);
        }

        if (!confText) {
          confText = this.extractText($row, [
            'td.confidence', 'td.probability', 'td.chance',
          ]);
        }

        const { gameDate, gameTime } = this.parseDateTime(timeText, fetchedAt);
        const { pickType, side, value } = this.parseTip(tipText);
        const confidence = this.parseConfidenceText(confText);

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
          pickerName: 'SoccerPredictions365',
          confidence,
          reasoning: currentLeague || null,
          fetchedAt,
        });
      });

      if (predictions.length > 0) break;
    }

    return predictions;
  }

  private parseMatchRow(
    $: ReturnType<typeof this.load>,
    $row: ReturnType<ReturnType<typeof this.load>>,
    sport: string,
    league: string,
    fetchedAt: Date,
  ): RawPrediction[] | null {
    const homeTeamRaw = this.extractText($row, [
      '.home-team', '.home', '.team-home', '.team-a',
      '.team:first-child', 'td:nth-child(1)',
    ]);
    const awayTeamRaw = this.extractText($row, [
      '.away-team', '.away', '.team-away', '.team-b',
      '.team:last-child', 'td:nth-child(2)',
    ]);
    if (!homeTeamRaw || !awayTeamRaw) return null;

    const tipText = this.extractText($row, [
      '.tip', '.prediction', '.pick', '.market',
      'td:nth-child(3)', '.prediction-value',
    ]);
    if (!tipText) return null;

    const confText = this.extractText($row, [
      '.confidence', '.probability', '.chance', 'td:nth-child(4)',
    ]);

    const timeText = this.extractText($row, [
      '.time', '.date', '.kickoff', 'td.time',
    ]);
    const { gameDate, gameTime } = this.parseDateTime(timeText, fetchedAt);
    const { pickType, side, value } = this.parseTip(tipText);
    const confidence = this.parseConfidenceText(confText);

    return [{
      sourceId: this.config.id,
      sport,
      homeTeamRaw,
      awayTeamRaw,
      gameDate,
      gameTime,
      pickType,
      side,
      value,
      pickerName: 'SoccerPredictions365',
      confidence,
      reasoning: league || null,
      fetchedAt,
    }];
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

    // Over/Under with value
    const ouMatch = lower.match(/^(over|under)\s*([\d.]+)/);
    if (ouMatch) {
      return {
        pickType: 'over_under',
        side: ouMatch[1] as Side,
        value: parseFloat(ouMatch[2]!),
      };
    }

    // Shorthand: "o2.5", "u2.5"
    const shortOu = lower.match(/^(o|u)\s*([\d.]+)/);
    if (shortOu) {
      return {
        pickType: 'over_under',
        side: shortOu[1] === 'o' ? 'over' : 'under',
        value: parseFloat(shortOu[2]!),
      };
    }

    // BTTS
    if (lower === 'gg' || lower === 'btts' || lower === 'btts yes' || lower === 'btts - yes') {
      return { pickType: 'prop', side: 'yes', value: null };
    }
    if (lower === 'ng' || lower === 'btts no' || lower === 'btts - no') {
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

  private parseConfidenceText(text: string): Confidence | null {
    if (!text) return null;

    // Percentage: "85%", "85 %"
    const pctMatch = text.match(/([\d.]+)\s*%/);
    if (pctMatch) {
      const pct = parseFloat(pctMatch[1]!);
      if (isNaN(pct)) return null;
      if (pct >= 75) return 'best_bet';
      if (pct >= 60) return 'high';
      if (pct >= 45) return 'medium';
      return 'low';
    }

    // Fractional: "4/5"
    const fracMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (fracMatch) {
      const score = parseInt(fracMatch[1]!, 10);
      const max = parseInt(fracMatch[2]!, 10);
      if (max > 0) {
        const ratio = score / max;
        if (ratio >= 0.8) return 'best_bet';
        if (ratio >= 0.6) return 'high';
        if (ratio >= 0.4) return 'medium';
        return 'low';
      }
    }

    // Plain number
    const numMatch = text.match(/([\d.]+)/);
    if (numMatch) {
      const num = parseFloat(numMatch[1]!);
      if (!isNaN(num) && num <= 100) {
        if (num >= 75) return 'best_bet';
        if (num >= 60) return 'high';
        if (num >= 45) return 'medium';
        return 'low';
      }
    }

    // Text-based
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
