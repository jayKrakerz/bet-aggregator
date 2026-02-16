import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Predictz adapter.
 *
 * Cloudflare-protected site requiring browser rendering.
 *
 * Page structure:
 *   - `.pointed` table rows for each match prediction
 *   - Teams in adjacent cells, home first
 *   - Prediction: "1", "X", or "2" in a highlighted cell
 *   - Odds: decimal odds in three cells (home/draw/away)
 *   - Score prediction: "X-Y" format
 *   - League: section headers
 */
export class PredictzAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'predictz',
    name: 'Predictz',
    baseUrl: 'https://www.predictz.com',
    fetchMethod: 'browser',
    paths: { football: '/predictions/today/' },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('table.pointed, .pointed, .pttr', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentLeague = '';

    // Predictz uses table rows with class "pointed" or similar
    $('table tr, .pointed tr, .pttr').each((_i, el) => {
      const $row = $(el);
      const cells = $row.find('td');

      // League header rows typically have colspan or a single cell
      if (cells.length === 1 || (cells.length > 0 && cells.first().attr('colspan'))) {
        const text = cells.first().text().trim();
        if (text && !text.match(/^\d/)) {
          currentLeague = text;
        }
        return;
      }

      // Match rows need enough cells for teams + prediction + odds
      if (cells.length < 5) return;

      // Extract teams — look for links or plain text
      const homeTeamRaw = this.findTeam($, cells, 0);
      const awayTeamRaw = this.findTeam($, cells, 1);
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Find the prediction cell (bold or highlighted)
      const predText = this.findPrediction($, cells);
      if (!predText) return;

      const side = this.mapSide(predText);
      if (!side) return;

      // Extract odds
      const odds = this.extractOdds($, cells);
      let value: number | null = null;
      if (side === 'home' && odds[0]) value = odds[0];
      else if (side === 'draw' && odds[1]) value = odds[1];
      else if (side === 'away' && odds[2]) value = odds[2];

      // Extract score prediction
      const scorePred = this.findScore($, cells);

      // Extract date/time
      const timeText = cells.first().text().trim();
      const timeMatch = timeText.match(/(\d{1,2}:\d{2})/);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate: fetchedAt.toISOString().split('T')[0]!,
        gameTime: timeMatch ? timeMatch[1]! : null,
        pickType: 'moneyline',
        side,
        value,
        pickerName: 'Predictz',
        confidence: this.oddsToConfidence(value),
        reasoning: [currentLeague, scorePred ? `Predicted: ${scorePred}` : ''].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private findTeam(
    $: ReturnType<typeof this.load>,
    cells: ReturnType<ReturnType<typeof this.load>>,
    index: number,
  ): string {
    // Teams might be in cells with links or direct text
    for (let i = 0; i < cells.length; i++) {
      const cell = $(cells[i]);
      const link = cell.find('a');
      const text = link.length > 0 ? link.first().text().trim() : cell.text().trim();
      // Skip cells that look like times, odds, or predictions
      if (!text || /^\d{1,2}:\d{2}$/.test(text) || /^\d+\.\d+$/.test(text) || /^[12X]$/.test(text)) continue;
      if (index === 0) return text;
      index--;
    }
    return '';
  }

  private findPrediction(
    $: ReturnType<typeof this.load>,
    cells: ReturnType<ReturnType<typeof this.load>>,
  ): string {
    // Look for bold text or highlighted cell with 1, X, or 2
    for (let i = 0; i < cells.length; i++) {
      const cell = $(cells[i]);
      const bold = cell.find('b, strong').text().trim();
      if (/^[12X]$/i.test(bold)) return bold;
    }
    // Fallback: look for cell with specific class
    for (let i = 0; i < cells.length; i++) {
      const cell = $(cells[i]);
      const text = cell.text().trim();
      if (/^[12X]$/i.test(text) && (cell.hasClass('pointed3') || cell.css('font-weight') === 'bold')) {
        return text;
      }
    }
    return '';
  }

  private extractOdds(
    $: ReturnType<typeof this.load>,
    cells: ReturnType<ReturnType<typeof this.load>>,
  ): number[] {
    const odds: number[] = [];
    for (let i = 0; i < cells.length; i++) {
      const text = $(cells[i]).text().trim();
      const val = parseFloat(text);
      if (!isNaN(val) && val > 1.0 && val < 50) {
        odds.push(val);
      }
    }
    return odds;
  }

  private findScore(
    $: ReturnType<typeof this.load>,
    cells: ReturnType<ReturnType<typeof this.load>>,
  ): string {
    for (let i = 0; i < cells.length; i++) {
      const text = $(cells[i]).text().trim();
      if (/^\d+-\d+$/.test(text) || /^\d+:\d+$/.test(text)) return text;
    }
    return '';
  }

  private mapSide(pred: string): Side | null {
    if (pred === '1') return 'home';
    if (pred.toUpperCase() === 'X') return 'draw';
    if (pred === '2') return 'away';
    return null;
  }

  private oddsToConfidence(odds: number | null): Confidence | null {
    if (!odds) return null;
    if (odds <= 1.3) return 'best_bet';
    if (odds <= 1.7) return 'high';
    if (odds <= 2.5) return 'medium';
    return 'low';
  }
}
