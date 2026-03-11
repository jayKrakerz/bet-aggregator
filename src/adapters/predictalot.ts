import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * PredictSoccer adapter (formerly PredictALot).
 *
 * NOTE: predictsoccer.com is currently a parked/expired domain
 * (redirects to HugeDomains). This adapter is kept as a placeholder
 * with robust parsing strategies so it can resume if the domain comes back
 * or is pointed to a new site.
 *
 * Expected layout patterns:
 *   - Match rows with home/away teams and percentage-based predictions
 *   - Table-based layout with columns for teams, 1X2 probabilities, tips
 *   - Card-based layout with match cards containing prediction data
 */
export class PredictALotAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'predictsoccer',
    name: 'PredictSoccer',
    baseUrl: 'https://www.predictsoccer.com',
    fetchMethod: 'http',
    paths: {
      football: '/',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Strategy 1: Card/row-based layout
    const rowSelectors = [
      '.prediction-card', '.match-card', '.game-card',
      '.game-row', '.match-row', '.prediction-row',
      '.fixture-row', '.match-item', '.prediction-item',
      '.event-row', '.tip-card',
    ];

    for (const rowSel of rowSelectors) {
      if ($(rowSel).length === 0) continue;

      $(rowSel).each((_i, el) => {
        const $row = $(el);

        const homeTeamRaw = this.extractText($row, [
          '.home-team', '.home', '.team-home', '.team-a',
          '.team:first-child', 'span.home', '.teams .home',
        ]);
        const awayTeamRaw = this.extractText($row, [
          '.away-team', '.away', '.team-away', '.team-b',
          '.team:last-child', 'span.away', '.teams .away',
        ]);
        if (!homeTeamRaw || !awayTeamRaw) return;

        // Try percentage-based predictions
        const homePercText = this.extractText($row, [
          '.home-percent', '.prob-home', '.pct-home', '.home-pct',
          '.prediction-home', '.percent:first-child',
        ]);
        const drawPercText = this.extractText($row, [
          '.draw-percent', '.prob-draw', '.pct-draw', '.draw-pct',
          '.prediction-draw', '.percent:nth-child(2)',
        ]);
        const awayPercText = this.extractText($row, [
          '.away-percent', '.prob-away', '.pct-away', '.away-pct',
          '.prediction-away', '.percent:last-child',
        ]);

        const homePerc = this.parsePercent(homePercText);
        const drawPerc = this.parsePercent(drawPercText);
        const awayPerc = this.parsePercent(awayPercText);

        // Also try explicit tip text
        const tipText = this.extractText($row, [
          '.tip', '.prediction', '.pick', '.recommended',
          '.prediction-value', '.bet-tip', '.market',
        ]);

        const league = this.extractText($row, [
          '.league', '.league-name', '.competition', '.tournament',
          '.country', '.event-league',
        ]);

        const oddsText = this.extractText($row, [
          '.odds', '.odd', '.price', '.odds-value',
        ]);
        const odds = parseFloat(oddsText) || null;

        const timeText = this.extractText($row, [
          '.time', '.date', '.kick-off', '.kickoff',
          '.match-time', '.match-date',
        ]);
        const { gameDate, gameTime } = this.parseDateTime(timeText, fetchedAt);

        if (homePerc !== null || drawPerc !== null || awayPerc !== null) {
          const { side, confidence } = this.percentagesToPrediction(homePerc, drawPerc, awayPerc);

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'moneyline',
            side,
            value: null,
            pickerName: 'PredictSoccer',
            confidence,
            reasoning: this.buildPercentageReasoning(homePerc, drawPerc, awayPerc, league),
            fetchedAt,
          });
        } else if (tipText) {
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
            pickerName: 'PredictSoccer',
            confidence: odds ? this.oddsToConfidence(odds) : null,
            reasoning: league || null,
            fetchedAt,
          });
        }
      });

      if (predictions.length > 0) return predictions;
    }

    // Strategy 2: Table-based layout
    const tableSelectors = [
      'table.predictions tbody tr',
      'table.results-table tbody tr',
      'table.matches tbody tr',
      'table tbody tr',
    ];

    for (const tableSel of tableSelectors) {
      const rows = $(tableSel);
      if (rows.length === 0) continue;

      let currentLeague = '';

      rows.each((_i, el) => {
        const $row = $(el);

        // Skip header rows
        if ($row.find('th').length > 0) return;

        // League separator
        const colspanCell = $row.find('td[colspan]');
        if (colspanCell.length > 0) {
          const text = colspanCell.text().trim();
          if (text.length > 2) currentLeague = text;
          return;
        }

        const cells = $row.find('td');
        if (cells.length < 4) return;

        let homeTeamRaw = '';
        let awayTeamRaw = '';
        let tipText = '';
        let homePerc: number | null = null;
        let drawPerc: number | null = null;
        let awayPerc: number | null = null;

        // Try combined teams cell
        for (let c = 0; c < Math.min(cells.length, 4); c++) {
          const cellText = $(cells[c]).text().trim();
          const sepMatch = cellText.match(/^(.+?)\s+(?:vs?\.?|[-–])\s+(.+)$/i);
          if (sepMatch && sepMatch[1] && sepMatch[2]) {
            homeTeamRaw = sepMatch[1].trim();
            awayTeamRaw = sepMatch[2].trim();
            break;
          }
        }

        if (!homeTeamRaw || !awayTeamRaw) {
          if (cells.length >= 7) {
            currentLeague = $(cells[0]).text().trim() || currentLeague;
            homeTeamRaw = $(cells[1]).text().trim();
            awayTeamRaw = $(cells[2]).text().trim();
            homePerc = this.parsePercent($(cells[3]).text().trim());
            drawPerc = this.parsePercent($(cells[4]).text().trim());
            awayPerc = this.parsePercent($(cells[5]).text().trim());
            tipText = $(cells[6]).text().trim();
          } else if (cells.length >= 5) {
            homeTeamRaw = $(cells[0]).text().trim();
            awayTeamRaw = $(cells[1]).text().trim();
            homePerc = this.parsePercent($(cells[2]).text().trim());
            drawPerc = this.parsePercent($(cells[3]).text().trim());
            awayPerc = this.parsePercent($(cells[4]).text().trim());
          } else if (cells.length >= 4) {
            homeTeamRaw = $(cells[0]).text().trim();
            awayTeamRaw = $(cells[1]).text().trim();
            tipText = $(cells[2]).text().trim();
          }
        }

        if (!homeTeamRaw || !awayTeamRaw) return;

        const timeText = this.extractText($row, ['td.time', 'td.date', 'td.kickoff']);
        const { gameDate, gameTime } = this.parseDateTime(timeText, fetchedAt);

        if (homePerc !== null || drawPerc !== null || awayPerc !== null) {
          const { side, confidence } = this.percentagesToPrediction(homePerc, drawPerc, awayPerc);

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'moneyline',
            side,
            value: null,
            pickerName: 'PredictSoccer',
            confidence,
            reasoning: this.buildPercentageReasoning(homePerc, drawPerc, awayPerc, currentLeague),
            fetchedAt,
          });
        } else if (tipText) {
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
            pickerName: 'PredictSoccer',
            confidence: null,
            reasoning: currentLeague || null,
            fetchedAt,
          });
        }
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

  private parsePercent(text: string): number | null {
    if (!text) return null;
    const match = text.match(/([\d.]+)\s*%?/);
    if (!match) return null;
    const val = parseFloat(match[1]!);
    return isNaN(val) ? null : val;
  }

  private percentagesToPrediction(
    homePerc: number | null,
    drawPerc: number | null,
    awayPerc: number | null,
  ): { side: Side; confidence: Confidence | null } {
    const h = homePerc ?? 0;
    const d = drawPerc ?? 0;
    const a = awayPerc ?? 0;
    const max = Math.max(h, d, a);

    let side: Side;
    if (max === h) side = 'home';
    else if (max === a) side = 'away';
    else side = 'draw';

    const confidence = this.percentToConfidence(max);
    return { side, confidence };
  }

  private percentToConfidence(pct: number): Confidence | null {
    if (pct <= 0) return null;
    if (pct >= 75) return 'best_bet';
    if (pct >= 60) return 'high';
    if (pct >= 45) return 'medium';
    return 'low';
  }

  private buildPercentageReasoning(
    homePerc: number | null,
    drawPerc: number | null,
    awayPerc: number | null,
    league: string,
  ): string {
    const parts: string[] = [];
    if (homePerc !== null) parts.push(`Home: ${homePerc}%`);
    if (drawPerc !== null) parts.push(`Draw: ${drawPerc}%`);
    if (awayPerc !== null) parts.push(`Away: ${awayPerc}%`);
    const probStr = parts.join(', ');
    return league ? `${probStr} | ${league}` : probStr;
  }

  private parseTip(tip: string): {
    pickType: RawPrediction['pickType'];
    side: Side;
    value: number | null;
  } {
    const lower = tip.toLowerCase().trim();

    const ouMatch = lower.match(/^(over|under)\s*([\d.]+)/);
    if (ouMatch) {
      return {
        pickType: 'over_under',
        side: ouMatch[1] as Side,
        value: parseFloat(ouMatch[2]!),
      };
    }

    if (lower === 'gg' || lower === 'btts' || lower === 'btts yes') {
      return { pickType: 'prop', side: 'yes', value: null };
    }
    if (lower === 'ng' || lower === 'btts no') {
      return { pickType: 'prop', side: 'no', value: null };
    }

    const side = this.tipToSide(lower);
    return { pickType: 'moneyline', side, value: null };
  }

  private tipToSide(tip: string): Side {
    switch (tip) {
      case '1': case 'h': case 'home': case 'home win': case '1x': return 'home';
      case '2': case 'a': case 'away': case 'away win': case 'x2': return 'away';
      case 'x': case 'd': case 'draw': return 'draw';
      default: return 'home';
    }
  }

  private oddsToConfidence(odds: number): Confidence | null {
    if (odds <= 0) return null;
    const impliedProb = 1 / odds;
    if (impliedProb >= 0.75) return 'best_bet';
    if (impliedProb >= 0.55) return 'high';
    if (impliedProb >= 0.35) return 'medium';
    return 'low';
  }

  private parseDateTime(
    text: string,
    fetchedAt: Date,
  ): { gameDate: string; gameTime: string | null } {
    if (!text) {
      return { gameDate: fetchedAt.toISOString().split('T')[0]!, gameTime: null };
    }

    const full = text.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s+(\d{1,2}:\d{2})/);
    if (full) {
      const day = full[1]!.padStart(2, '0');
      const month = full[2]!.padStart(2, '0');
      return { gameDate: `${full[3]}-${month}-${day}`, gameTime: full[4]! };
    }

    const dateOnly = text.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
    if (dateOnly) {
      const day = dateOnly[1]!.padStart(2, '0');
      const month = dateOnly[2]!.padStart(2, '0');
      return { gameDate: `${dateOnly[3]}-${month}-${day}`, gameTime: null };
    }

    const timeOnly = text.match(/(\d{1,2}:\d{2})/);
    return {
      gameDate: fetchedAt.toISOString().split('T')[0]!,
      gameTime: timeOnly ? timeOnly[1]! : null,
    };
  }
}
