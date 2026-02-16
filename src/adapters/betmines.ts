import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * BetMines adapter.
 *
 * Cloudflare-protected site with AI-generated football predictions.
 * Requires Playwright for browser rendering.
 *
 * Page structure:
 *   - Match cards/rows with predictions
 *   - Teams displayed in match header
 *   - Multiple prediction types per match (1X2, O/U, BTTS)
 *   - Probability/confidence indicators
 *   - League groupings
 */
export class BetMinesAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'betmines',
    name: 'BetMines',
    baseUrl: 'https://betmines.com',
    fetchMethod: 'browser',
    paths: { football: '/predictions/' },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('.match-card, .prediction-card, .match-row, table', { timeout: 20000 }).catch(() => {});
    // Scroll to trigger lazy loading
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
    await page.evaluate('window.scrollTo(0, 0)');
    await page.waitForTimeout(1000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Try card-based layout first
    const cardSelectors = [
      '.match-card',
      '.prediction-card',
      '.match-row',
      '.game-card',
      'table.predictions tbody tr',
    ];

    for (const sel of cardSelectors) {
      if ($(sel).length === 0) continue;

      $(sel).each((_i, el) => {
      const $card = $(el);

      // Extract teams
      const { homeTeamRaw, awayTeamRaw } = this.extractTeams($, $card);
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Extract date/time
      const dateText = $card.find('.match-date, .date, time, .kick-off').first().text().trim();
      const { gameDate, gameTime } = this.parseDate(dateText, fetchedAt);

      // Extract league
      const league = $card.find('.league, .competition, .tournament').first().text().trim();

      // Extract all predictions from the card
      const cardPredictions = this.extractPredictions($, $card);

      for (const pred of cardPredictions) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: pred.pickType,
          side: pred.side,
          value: pred.value,
          pickerName: 'BetMines AI',
          confidence: pred.confidence,
          reasoning: league || null,
          fetchedAt,
        });
      }
      });
      break;
    }

    return predictions;
  }

  private extractTeams(
    $: ReturnType<typeof this.load>,
    $card: ReturnType<ReturnType<typeof this.load>>,
  ): { homeTeamRaw: string; awayTeamRaw: string } {
    // Try specific class selectors
    let homeTeamRaw = $card.find('.home-team, .team-home, .team-a').first().text().trim();
    let awayTeamRaw = $card.find('.away-team, .team-away, .team-b').first().text().trim();

    if (homeTeamRaw && awayTeamRaw) return { homeTeamRaw, awayTeamRaw };

    // Try "home vs away" pattern
    const matchHeader = $card.find('.match-header, .match-title, .teams').first().text().trim();
    const vsMatch = matchHeader.match(/^(.+?)\s+(?:v|vs\.?|-)\s+(.+)$/i);
    if (vsMatch) {
      return { homeTeamRaw: vsMatch[1]!.trim(), awayTeamRaw: vsMatch[2]!.trim() };
    }

    // Try table cells
    const cells = $card.find('td');
    if (cells.length >= 3) {
      const links = $card.find('a');
      if (links.length >= 2) {
        homeTeamRaw = $(links[0]).text().trim();
        awayTeamRaw = $(links[1]).text().trim();
        if (homeTeamRaw && awayTeamRaw) return { homeTeamRaw, awayTeamRaw };
      }
    }

    return { homeTeamRaw: '', awayTeamRaw: '' };
  }

  private extractPredictions(
    $: ReturnType<typeof this.load>,
    $card: ReturnType<ReturnType<typeof this.load>>,
  ): Array<{ pickType: RawPrediction['pickType']; side: Side; value: number | null; confidence: Confidence | null }> {
    const results: Array<{ pickType: RawPrediction['pickType']; side: Side; value: number | null; confidence: Confidence | null }> = [];

    // Look for individual prediction items within the card
    const predItems = $card.find('.prediction-item, .tip-item, .bet-tip, .pick');

    if (predItems.length > 0) {
      predItems.each((_i, item) => {
        const tipText = $(item).find('.tip-value, .prediction-value, .value').first().text().trim()
          || $(item).text().trim();
        const probText = $(item).find('.probability, .percent, .confidence').first().text().trim();
        const pred = this.parseTip(tipText);
        if (pred) {
          results.push({
            ...pred,
            confidence: this.parseProbability(probText),
          });
        }
      });
    }

    // Fallback: look for a single prediction
    if (results.length === 0) {
      const tipText = $card.find('.prediction, .tip, .pick-value').first().text().trim();
      const probText = $card.find('.probability, .percent, .accuracy').first().text().trim();
      const pred = this.parseTip(tipText);
      if (pred) {
        results.push({
          ...pred,
          confidence: this.parseProbability(probText),
        });
      }
    }

    return results;
  }

  private parseTip(tip: string): { pickType: RawPrediction['pickType']; side: Side; value: number | null } | null {
    if (!tip) return null;
    const lower = tip.toLowerCase().trim();

    const ouMatch = lower.match(/(over|under)\s+([\d.]+)/);
    if (ouMatch) {
      return { pickType: 'over_under', side: ouMatch[1] as Side, value: parseFloat(ouMatch[2]!) };
    }

    if (lower.includes('btts yes') || lower === 'gg' || lower === 'btts - yes') {
      return { pickType: 'prop', side: 'yes', value: null };
    }
    if (lower.includes('btts no') || lower === 'ng' || lower === 'btts - no') {
      return { pickType: 'prop', side: 'no', value: null };
    }

    if (lower === '1' || lower === 'home' || lower === 'home win') {
      return { pickType: 'moneyline', side: 'home', value: null };
    }
    if (lower === 'x' || lower === 'draw') {
      return { pickType: 'moneyline', side: 'draw', value: null };
    }
    if (lower === '2' || lower === 'away' || lower === 'away win') {
      return { pickType: 'moneyline', side: 'away', value: null };
    }

    if (lower === '1x') return { pickType: 'moneyline', side: 'home', value: null };
    if (lower === 'x2') return { pickType: 'moneyline', side: 'away', value: null };

    return null;
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
