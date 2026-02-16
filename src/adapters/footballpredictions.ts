import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Football Predictions adapter.
 *
 * WordPress site with prediction cards for football matches.
 *
 * Page structure:
 *   - `.prediction-card` or `.match-prediction` — one per game
 *   - Teams: `.home-team` / `.away-team` or in match header
 *   - Prediction: `.prediction-value` or `.tip` — "1", "X", "2", "Over 2.5", etc.
 *   - Probability: `.probability` or `.chance` — percentage text
 *   - Date: `.match-date` or `.date` — DD/MM/YYYY or similar
 *   - League: `.league-name` or `.competition`
 */
export class FootballPredictionsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'footballpredictions',
    name: 'Football Predictions',
    baseUrl: 'https://footballpredictions.com',
    fetchMethod: 'http',
    paths: { football: '/predictions/today/' },
    cron: '0 0 7,12,18 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Try multiple common selectors for prediction cards
    const cardSelectors = [
      '.prediction-card',
      '.match-prediction',
      '.match-row',
      'table.predictions tbody tr',
      '.predictions-list .prediction',
    ];

    for (const sel of cardSelectors) {
      if ($(sel).length === 0) continue;

      $(sel).each((_i, el) => {
      const $card = $(el);

      // Extract teams
      const homeTeamRaw = this.extractText($card, [
        '.home-team', '.team-home', '.home', 'td:nth-child(1)',
      ]);
      const awayTeamRaw = this.extractText($card, [
        '.away-team', '.team-away', '.away', 'td:nth-child(3)',
      ]);
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Extract prediction tip
      const tipText = this.extractText($card, [
        '.prediction-value', '.tip', '.pick', '.prediction-tip',
        'td.prediction', '.pred',
      ]);
      if (!tipText) return;

      const { pickType, side, value } = this.parseTip(tipText);

      // Extract date
      const dateText = this.extractText($card, [
        '.match-date', '.date', '.kick-off', 'td.date', 'time',
      ]);
      const { gameDate, gameTime } = this.parseMatchDate(dateText, fetchedAt);

      // Extract probability/confidence
      const probText = this.extractText($card, [
        '.probability', '.chance', '.confidence', '.percentage',
      ]);
      const confidence = this.parseProbability(probText);

      // Extract league for reasoning
      const league = this.extractText($card, [
        '.league-name', '.competition', '.league', '.tournament',
      ]);

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
        pickerName: 'Football Predictions',
        confidence,
        reasoning: league || null,
        fetchedAt,
      });
      });
      break;
    }

    return predictions;
  }

  private extractText(
    $card: ReturnType<ReturnType<typeof this.load>>,
    selectors: string[],
  ): string {
    for (const sel of selectors) {
      const text = $card.find(sel).first().text().trim();
      if (text) return text;
    }
    return '';
  }

  private parseTip(tip: string): { pickType: RawPrediction['pickType']; side: Side; value: number | null } {
    const lower = tip.toLowerCase().trim();

    // Over/Under
    const ouMatch = lower.match(/^(over|under)\s+([\d.]+)/);
    if (ouMatch) {
      return {
        pickType: 'over_under',
        side: ouMatch[1] as Side,
        value: parseFloat(ouMatch[2]!),
      };
    }

    // BTTS
    if (lower === 'btts yes' || lower === 'gg') return { pickType: 'prop', side: 'yes', value: null };
    if (lower === 'btts no' || lower === 'ng') return { pickType: 'prop', side: 'no', value: null };

    // 1X2
    if (lower === '1' || lower === 'home' || lower === 'home win') {
      return { pickType: 'moneyline', side: 'home', value: null };
    }
    if (lower === 'x' || lower === 'draw') {
      return { pickType: 'moneyline', side: 'draw', value: null };
    }
    if (lower === '2' || lower === 'away' || lower === 'away win') {
      return { pickType: 'moneyline', side: 'away', value: null };
    }

    // Double chance
    if (lower === '1x') return { pickType: 'moneyline', side: 'home', value: null };
    if (lower === 'x2') return { pickType: 'moneyline', side: 'away', value: null };

    return { pickType: 'moneyline', side: 'home', value: null };
  }

  private parseMatchDate(
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

    // HH:MM only
    const timeOnly = text.match(/(\d{1,2}:\d{2})/);
    return {
      gameDate: fetchedAt.toISOString().split('T')[0]!,
      gameTime: timeOnly ? timeOnly[1]! : null,
    };
  }

  private parseProbability(text: string): Confidence | null {
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
