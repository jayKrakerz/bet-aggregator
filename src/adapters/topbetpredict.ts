import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * TopBetPredict adapter.
 *
 * Country-grouped prediction lists with `data-anwp-country` attributes.
 *
 * Page structure:
 *   - Matches grouped by country/league via `[data-anwp-country]` containers
 *   - Each match row contains home/away teams, prediction, and odds
 *   - Predictions: "1", "X", "2", "Over 2.5", "Under 2.5", "BTTS Yes/No"
 *   - Date/time in match header or row
 */
export class TopBetPredictAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'topbetpredict',
    name: 'TopBetPredict',
    baseUrl: 'https://topbetpredict.com',
    fetchMethod: 'http',
    paths: { football: '/football-predictions-today/' },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Try country-grouped containers first
    const containers = $('[data-anwp-country]');
    if (containers.length > 0) {
      containers.each((_i, container) => {
        const $container = $(container);
        const league = $container.find('.anwp-fl-league-title, .league-title').first().text().trim();

        $container.find('.anwp-fl-match, .match-row, tr').each((_j, row) => {
          const pred = this.parseMatchRow($, $(row), sport, league, fetchedAt);
          if (pred) predictions.push(pred);
        });
      });
    } else {
      // Fallback: table-based layout
      let currentLeague = '';
      $('table tbody tr, .prediction-row, .match-item').each((_i, row) => {
        const $row = $(row);

        // League header check
        const headerCell = $row.find('td[colspan], .league-header');
        if (headerCell.length > 0 && headerCell.attr('colspan')) {
          currentLeague = headerCell.text().trim();
          return;
        }

        const pred = this.parseMatchRow($, $row, sport, currentLeague, fetchedAt);
        if (pred) predictions.push(pred);
      });
    }

    return predictions;
  }

  private parseMatchRow(
    $: ReturnType<typeof this.load>,
    $row: ReturnType<ReturnType<typeof this.load>>,
    sport: string,
    league: string,
    fetchedAt: Date,
  ): RawPrediction | null {
    // Extract teams
    const homeTeamRaw =
      $row.find('.anwp-fl-match__team-home, .home-team, td:nth-child(1)').first().text().trim();
    const awayTeamRaw =
      $row.find('.anwp-fl-match__team-away, .away-team, td:nth-child(2)').first().text().trim();

    if (!homeTeamRaw || !awayTeamRaw) return null;

    // Extract prediction
    const tipText =
      $row.find('.anwp-fl-match__prediction, .prediction, .tip, td.prediction').first().text().trim();
    if (!tipText) return null;

    const { pickType, side, value } = this.parseTip(tipText);

    // Extract odds
    let oddsValue: number | null = value;
    if (oddsValue === null) {
      const oddsText = $row.find('.odds, td.odds').first().text().trim();
      oddsValue = parseFloat(oddsText) || null;
    }

    // Extract date/time
    const dateText = $row.find('.match-date, .date, time, td.time').first().text().trim();
    const { gameDate, gameTime } = this.parseDate(dateText, fetchedAt);

    // Extract probability
    const probText = $row.find('.probability, .percent, .chance').first().text().trim();
    const confidence = this.parseProb(probText);

    return {
      sourceId: this.config.id,
      sport,
      homeTeamRaw,
      awayTeamRaw,
      gameDate,
      gameTime,
      pickType,
      side,
      value: oddsValue,
      pickerName: 'TopBetPredict',
      confidence,
      reasoning: league || null,
      fetchedAt,
    };
  }

  private parseTip(tip: string): { pickType: RawPrediction['pickType']; side: Side; value: number | null } {
    const lower = tip.toLowerCase().trim();

    const ouMatch = lower.match(/^(over|under)\s+([\d.]+)/);
    if (ouMatch) {
      return { pickType: 'over_under', side: ouMatch[1] as Side, value: parseFloat(ouMatch[2]!) };
    }

    if (lower.includes('btts yes') || lower === 'gg') return { pickType: 'prop', side: 'yes', value: null };
    if (lower.includes('btts no') || lower === 'ng') return { pickType: 'prop', side: 'no', value: null };

    if (lower === '1' || lower === 'home') return { pickType: 'moneyline', side: 'home', value: null };
    if (lower === 'x' || lower === 'draw') return { pickType: 'moneyline', side: 'draw', value: null };
    if (lower === '2' || lower === 'away') return { pickType: 'moneyline', side: 'away', value: null };

    if (lower === '1x') return { pickType: 'moneyline', side: 'home', value: null };
    if (lower === 'x2') return { pickType: 'moneyline', side: 'away', value: null };
    if (lower === '12') return { pickType: 'moneyline', side: 'home', value: null };

    return { pickType: 'moneyline', side: 'home', value: null };
  }

  private parseDate(
    text: string,
    fetchedAt: Date,
  ): { gameDate: string; gameTime: string | null } {
    if (!text) return { gameDate: fetchedAt.toISOString().split('T')[0]!, gameTime: null };

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

  private parseProb(text: string): Confidence | null {
    if (!text) return null;
    const match = text.match(/([\d.]+)/);
    if (!match) return null;
    const prob = parseFloat(match[1]!);
    if (isNaN(prob)) return null;
    if (prob >= 75) return 'best_bet';
    if (prob >= 60) return 'high';
    if (prob >= 45) return 'medium';
    return 'low';
  }
}
