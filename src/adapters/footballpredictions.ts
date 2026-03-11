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
    paths: { football: '/footballpredictions/' },
    cron: '0 0 7,12,18 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Current site uses .news-box containers (one per league block) with
    // prediction links inside whose href encodes "{home}-vs-{away}-prediction-{DD-MM-YYYY}".
    // The visible text often contains "Prediction: {score}" and "Match Time & Date: …".
    // Also fall back to the legacy selectors if the site changes again.

    // --- Strategy 1: Parse prediction links from .news-box or the whole page ---
    const predictionLinks = $('a[href*="-vs-"][href*="prediction"]');
    if (predictionLinks.length > 0) {
      let currentLeague = '';

      predictionLinks.each((_i, el) => {
        const $link = $(el);
        const href = $link.attr('href') || '';
        const text = $link.text().trim();

        // Track league from nearest .nb-title ancestor or preceding heading
        const boxParent = $link.closest('.news-box');
        if (boxParent.length > 0) {
          const title = boxParent.find('.nb-title').first().text().trim();
          if (title) currentLeague = title.replace(/\s*predictions?\s*$/i, '').trim();
        }

        // Extract teams from href: …/{home}-vs-{away}-prediction-{DD-MM-YYYY}/
        const hrefMatch = href.match(/\/([^/]+)-vs-([^/]+)-prediction[^/]*/i);
        if (!hrefMatch) return;

        const homeTeamRaw = hrefMatch[1]!.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const awayTeamRaw = hrefMatch[2]!.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        // Extract predicted score from visible text ("Prediction: 2-0" or "Espanyol 2 - 0 Oviedo")
        const scoreMatch = text.match(/(?:prediction[:\s]*)?(\d+)\s*-\s*(\d+)/i);
        let tipText = '';
        if (scoreMatch) {
          const homeGoals = parseInt(scoreMatch[1]!, 10);
          const awayGoals = parseInt(scoreMatch[2]!, 10);
          if (homeGoals > awayGoals) tipText = '1';
          else if (awayGoals > homeGoals) tipText = '2';
          else tipText = 'X';
        }

        // Extract date from href: …-prediction-DD-MM-YYYY/
        const dateMatch = href.match(/prediction-(\d{2})-(\d{2})-(\d{4})/);

        // Extract date from text: "Match Time & Date: 9 March 2026 20:00" or similar
        const textDateMatch = text.match(/(\d{1,2})\s+(\w+)\s+(\d{4})\s+(\d{1,2}:\d{2})/);

        let gameDate = fetchedAt.toISOString().split('T')[0]!;
        let gameTime: string | null = null;
        if (dateMatch) {
          gameDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
        } else if (textDateMatch) {
          const parsed = this.parseMatchDate(`${textDateMatch[1]} ${textDateMatch[2]} ${textDateMatch[3]}`, fetchedAt);
          gameDate = parsed.gameDate;
          gameTime = textDateMatch[4]!;
        }

        const { pickType, side, value } = tipText
          ? this.parseTip(tipText)
          : { pickType: 'moneyline' as const, side: 'home' as const, value: null };

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
          confidence: null,
          reasoning: currentLeague || null,
          fetchedAt,
        });
      });
    }

    // --- Strategy 2: Legacy card-based selectors ---
    if (predictions.length === 0) {
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

          const homeTeamRaw = this.extractText($card, [
            '.home-team', '.team-home', '.home', 'td:nth-child(1)',
          ]);
          const awayTeamRaw = this.extractText($card, [
            '.away-team', '.team-away', '.away', 'td:nth-child(3)',
          ]);
          if (!homeTeamRaw || !awayTeamRaw) return;

          const tipText = this.extractText($card, [
            '.prediction-value', '.tip', '.pick', '.prediction-tip',
            'td.prediction', '.pred',
          ]);
          if (!tipText) return;

          const { pickType, side, value } = this.parseTip(tipText);

          const dateText = this.extractText($card, [
            '.match-date', '.date', '.kick-off', 'td.date', 'time',
          ]);
          const { gameDate, gameTime } = this.parseMatchDate(dateText, fetchedAt);

          const probText = this.extractText($card, [
            '.probability', '.chance', '.confidence', '.percentage',
          ]);
          const confidence = this.parseProbability(probText);

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

    // "9 March 2026" or "09 March 2026"
    const months: Record<string, string> = {
      january: '01', february: '02', march: '03', april: '04',
      may: '05', june: '06', july: '07', august: '08',
      september: '09', october: '10', november: '11', december: '12',
    };
    const longDate = text.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
    if (longDate) {
      const m = months[longDate[2]!.toLowerCase()];
      if (m) {
        return {
          gameDate: `${longDate[3]}-${m}-${longDate[1]!.padStart(2, '0')}`,
          gameTime: null,
        };
      }
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
