import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * WinDrawWin adapter.
 *
 * Cloudflare-protected site with football predictions and statistical analysis.
 * Requires Playwright for browser rendering.
 *
 * Page structure:
 *   - Match rows in prediction tables
 *   - Teams as links within cells
 *   - Prediction: "W" (home win), "D" (draw), "L" (away win) or "1", "X", "2"
 *   - Probability percentages for each outcome
 *   - League groupings via header rows
 *   - Over/Under predictions on separate columns
 */
export class WinDrawWinAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'windrawwin',
    name: 'WinDrawWin',
    baseUrl: 'https://www.windrawwin.com',
    fetchMethod: 'browser',
    paths: { football: '/predictions/today/' },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('table, .pointed, .prediction', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentLeague = '';

    // WinDrawWin uses table rows for predictions
    $('table tr, .pointed, .prediction-row').each((_i, el) => {
      const $row = $(el);
      const cells = $row.find('td');

      // League header
      if (cells.length <= 2) {
        const text = $row.text().trim();
        if (text && !text.match(/^\d/) && text.length > 2 && text.length < 100) {
          currentLeague = text;
        }
        return;
      }

      if (cells.length < 4) return;

      // Extract teams from links or text
      const teamLinks = $row.find('a');
      let homeTeamRaw = '';
      let awayTeamRaw = '';
      let teamIdx = 0;

      teamLinks.each((_j, link) => {
        const text = $(link).text().trim();
        if (!text || /^\d/.test(text)) return;
        if (teamIdx === 0) { homeTeamRaw = text; teamIdx++; }
        else if (teamIdx === 1) { awayTeamRaw = text; teamIdx++; }
      });

      if (!homeTeamRaw || !awayTeamRaw) {
        // Fallback: try "home v away" or "home vs away" in a cell
        for (let i = 0; i < cells.length; i++) {
          const text = $(cells[i]).text().trim();
          const vsMatch = text.match(/^(.+?)\s+(?:v|vs\.?)\s+(.+)$/i);
          if (vsMatch) {
            homeTeamRaw = vsMatch[1]!.trim();
            awayTeamRaw = vsMatch[2]!.trim();
            break;
          }
        }
      }

      if (!homeTeamRaw || !awayTeamRaw) return;

      // Extract prediction and probabilities
      const { side, confidence } = this.extractPrediction($, cells);
      if (!side) return;

      // Extract time
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
        value: null,
        pickerName: 'WinDrawWin',
        confidence,
        reasoning: currentLeague || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private extractPrediction(
    $: ReturnType<typeof this.load>,
    cells: ReturnType<ReturnType<typeof this.load>>,
  ): { side: Side | null; confidence: Confidence | null } {
    // Look for percentages — three consecutive cells with XX% pattern
    const probs: Array<{ index: number; value: number }> = [];
    cells.each((i, cell) => {
      const text = $(cell).text().trim();
      const match = text.match(/^(\d{1,3})%?$/);
      if (match) {
        probs.push({ index: i, value: parseInt(match[1]!, 10) });
      }
    });

    if (probs.length >= 3) {
      const [home, draw, away] = [probs[0]!, probs[1]!, probs[2]!];
      const maxProb = Math.max(home.value, draw.value, away.value);
      let side: Side;
      if (maxProb === home.value) side = 'home';
      else if (maxProb === draw.value) side = 'draw';
      else side = 'away';
      return { side, confidence: this.probToConfidence(maxProb) };
    }

    // Look for W/D/L or 1/X/2 prediction markers
    for (let i = 0; i < cells.length; i++) {
      const cell = $(cells[i]);
      const text = cell.text().trim().toUpperCase();
      const bold = cell.find('b, strong').text().trim().toUpperCase();
      const marker = bold || text;

      if (marker === 'W' || marker === '1') return { side: 'home', confidence: null };
      if (marker === 'D' || marker === 'X') return { side: 'draw', confidence: null };
      if (marker === 'L' || marker === '2') return { side: 'away', confidence: null };
    }

    return { side: null, confidence: null };
  }

  private probToConfidence(prob: number): Confidence | null {
    if (isNaN(prob)) return null;
    if (prob >= 75) return 'best_bet';
    if (prob >= 60) return 'high';
    if (prob >= 45) return 'medium';
    return 'low';
  }
}
