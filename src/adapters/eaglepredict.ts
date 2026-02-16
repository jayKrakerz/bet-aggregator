import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * EaglePredict adapter.
 *
 * Laravel SPA with JSON-LD structured data embedded in the page.
 * Uses Playwright for rendering, then attempts to extract predictions
 * from JSON-LD first, falling back to DOM parsing.
 *
 * Page structure:
 *   - JSON-LD `<script type="application/ld+json">` blocks with match data
 *   - `.prediction-card` or `.match-card` containers
 *   - Teams in `.home-team` / `.away-team`
 *   - Prediction tip in `.prediction-tip` or `.tip-value`
 *   - Odds and probability in card footer
 */
export class EaglePredictAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'eaglepredict',
    name: 'EaglePredict',
    baseUrl: 'https://eaglepredict.com',
    fetchMethod: 'browser',
    paths: { football: '/football-predictions/' },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('.prediction-card, .match-card, table, .predictions', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    // Try JSON-LD extraction first
    const jsonLdPredictions = this.parseJsonLd(html, sport, fetchedAt);
    if (jsonLdPredictions.length > 0) return jsonLdPredictions;

    // Fallback to DOM parsing
    return this.parseDom(html, sport, fetchedAt);
  }

  private parseJsonLd(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const data = JSON.parse($(el).html() || '');
        const items = Array.isArray(data) ? data : [data];

        for (const item of items) {
          if (item['@type'] !== 'SportsEvent') continue;

          const homeTeam = item.homeTeam?.name || item.homeTeam;
          const awayTeam = item.awayTeam?.name || item.awayTeam;
          if (!homeTeam || !awayTeam) continue;

          const startDate = item.startDate || '';
          const gameDate = startDate.split('T')[0] || fetchedAt.toISOString().split('T')[0]!;
          const gameTime = this.extractTime(startDate);

          // Look for prediction data in custom properties
          const prediction = item.prediction || item.description || '';
          const { pickType, side, value } = this.parsePredictionText(
            typeof prediction === 'string' ? prediction : '',
          );

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: typeof homeTeam === 'string' ? homeTeam : homeTeam.name || '',
            awayTeamRaw: typeof awayTeam === 'string' ? awayTeam : awayTeam.name || '',
            gameDate,
            gameTime,
            pickType,
            side,
            value,
            pickerName: 'EaglePredict',
            confidence: null,
            reasoning: item.location?.name || null,
            fetchedAt,
          });
        }
      } catch {
        // Invalid JSON-LD, skip
      }
    });

    return predictions;
  }

  private parseDom(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    const cardSelectors = [
      '.prediction-card',
      '.match-card',
      '.prediction-item',
      'table.predictions tbody tr',
      '.match-row',
    ];

    for (const sel of cardSelectors) {
      if ($(sel).length === 0) continue;

      $(sel).each((_i, el) => {
      const $card = $(el);

      const homeTeamRaw = $card.find('.home-team, .team-home, td:first-child a').first().text().trim();
      const awayTeamRaw = $card.find('.away-team, .team-away, td:nth-child(3) a').first().text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      const tipText = $card.find('.prediction-tip, .tip-value, .tip, .prediction').first().text().trim();
      if (!tipText) return;

      const { pickType, side, value } = this.parsePredictionText(tipText);

      // Extract date
      const dateText = $card.find('.match-date, .date, time').first().text().trim();
      const { gameDate, gameTime } = this.parseDate(dateText, fetchedAt);

      // Extract probability
      const probText = $card.find('.probability, .percent, .confidence').first().text().trim();
      const confidence = this.parseProbability(probText);

      // Extract league
      const league = $card.find('.league, .competition').first().text().trim();

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
        pickerName: 'EaglePredict',
        confidence,
        reasoning: league || null,
        fetchedAt,
      });
      });
      break;
    }

    return predictions;
  }

  private parsePredictionText(text: string): { pickType: RawPrediction['pickType']; side: Side; value: number | null } {
    const lower = text.toLowerCase().trim();

    const ouMatch = lower.match(/(over|under)\s+([\d.]+)/);
    if (ouMatch) {
      return { pickType: 'over_under', side: ouMatch[1] as Side, value: parseFloat(ouMatch[2]!) };
    }

    if (lower.includes('btts yes') || lower === 'gg' || lower === 'yes') {
      return { pickType: 'prop', side: 'yes', value: null };
    }
    if (lower.includes('btts no') || lower === 'ng' || lower === 'no') {
      return { pickType: 'prop', side: 'no', value: null };
    }

    if (lower === '1' || lower === 'home win' || lower === 'home') {
      return { pickType: 'moneyline', side: 'home', value: null };
    }
    if (lower === 'x' || lower === 'draw') {
      return { pickType: 'moneyline', side: 'draw', value: null };
    }
    if (lower === '2' || lower === 'away win' || lower === 'away') {
      return { pickType: 'moneyline', side: 'away', value: null };
    }

    if (lower === '1x') return { pickType: 'moneyline', side: 'home', value: null };
    if (lower === 'x2') return { pickType: 'moneyline', side: 'away', value: null };

    return { pickType: 'moneyline', side: 'home', value: null };
  }

  private extractTime(isoString: string): string | null {
    if (!isoString) return null;
    const match = isoString.match(/T(\d{1,2}:\d{2})/);
    return match ? match[1]! : null;
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

    return { gameDate: fetchedAt.toISOString().split('T')[0]!, gameTime: null };
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
