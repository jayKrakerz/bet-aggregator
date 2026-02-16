import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * StatArea adapter.
 *
 * Legacy jQuery site (old.statarea.com) with dynamic rendering.
 * Uses Playwright for rendering, then parses tables with cheerio.
 *
 * Page structure:
 *   - Match rows in tables with home/away teams
 *   - Predictions based on statistical analysis (1X2, O/U, BTTS)
 *   - Probabilities shown as percentages
 *   - League headers in section dividers
 */
export class StatAreaAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'statarea',
    name: 'StatArea',
    baseUrl: 'https://old.statarea.com',
    fetchMethod: 'browser',
    paths: { football: '/predictions' },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('table, .match-row, .prediction-row', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentLeague = '';

    // StatArea uses table-based layout
    $('table tr, .match-row').each((_i, el) => {
      const $row = $(el);
      const cells = $row.find('td');

      // League header
      if (cells.length === 1 || (cells.length > 0 && cells.first().attr('colspan'))) {
        const text = cells.first().text().trim();
        if (text && text.length > 2) currentLeague = text;
        return;
      }

      if (cells.length < 4) return;

      // Extract teams
      const homeTeamRaw = this.extractTeam($, cells, 'home');
      const awayTeamRaw = this.extractTeam($, cells, 'away');
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Extract prediction and probabilities
      const predResults = this.extractPredictions($, $row, cells);
      if (predResults.length === 0) return;

      // Extract time
      const timeText = cells.first().text().trim();
      const timeMatch = timeText.match(/(\d{1,2}:\d{2})/);

      for (const pred of predResults) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: fetchedAt.toISOString().split('T')[0]!,
          gameTime: timeMatch ? timeMatch[1]! : null,
          pickType: pred.pickType,
          side: pred.side,
          value: pred.value,
          pickerName: 'StatArea',
          confidence: pred.confidence,
          reasoning: currentLeague || null,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private extractTeam(
    $: ReturnType<typeof this.load>,
    cells: ReturnType<ReturnType<typeof this.load>>,
    position: 'home' | 'away',
  ): string {
    // Look for team links or cells with team classes
    const teamCells = cells.filter((_i, cell) => {
      const classes = $(cell).attr('class') || '';
      return classes.includes(position) || classes.includes('team');
    });

    if (teamCells.length > 0) {
      const link = $(teamCells.first()).find('a');
      return link.length > 0 ? link.text().trim() : $(teamCells.first()).text().trim();
    }

    // Fallback: teams usually in early cells (skip time cell)
    const idx = position === 'home' ? 1 : 2;
    if (cells.length > idx) {
      const cell = $(cells[idx]);
      const link = cell.find('a');
      return link.length > 0 ? link.text().trim() : cell.text().trim();
    }

    return '';
  }

  private extractPredictions(
    $: ReturnType<typeof this.load>,
    $row: ReturnType<ReturnType<typeof this.load>>,
    cells: ReturnType<ReturnType<typeof this.load>>,
  ): Array<{ pickType: RawPrediction['pickType']; side: Side; value: number | null; confidence: Confidence | null }> {
    const results: Array<{ pickType: RawPrediction['pickType']; side: Side; value: number | null; confidence: Confidence | null }> = [];

    // Look for 1X2 probabilities
    const probCells: number[] = [];
    cells.each((i, cell) => {
      const text = $(cell).text().trim();
      if (/^\d{1,3}%?$/.test(text)) {
        probCells.push(i);
      }
    });

    if (probCells.length >= 3) {
      const homeProb = parseInt($(cells[probCells[0]!]).text().trim(), 10);
      const drawProb = parseInt($(cells[probCells[1]!]).text().trim(), 10);
      const awayProb = parseInt($(cells[probCells[2]!]).text().trim(), 10);

      // Pick the highest probability outcome
      const maxProb = Math.max(homeProb, drawProb, awayProb);
      let side: Side;
      if (maxProb === homeProb) side = 'home';
      else if (maxProb === drawProb) side = 'draw';
      else side = 'away';

      results.push({
        pickType: 'moneyline',
        side,
        value: null,
        confidence: this.probToConfidence(maxProb),
      });
    }

    // Look for O/U prediction
    const ouText = $row.find('.over-under, .ou-prediction, td:contains("Over"), td:contains("Under")').first().text().trim();
    if (ouText) {
      const ouMatch = ouText.match(/(over|under)\s*([\d.]+)/i);
      if (ouMatch) {
        results.push({
          pickType: 'over_under',
          side: ouMatch[1]!.toLowerCase() as Side,
          value: parseFloat(ouMatch[2]!),
          confidence: null,
        });
      }
    }

    // If no structured predictions found, look for a single prediction cell
    if (results.length === 0) {
      const predCell = $row.find('.prediction, .tip, b, strong');
      const predText = predCell.first().text().trim();
      if (/^[12X]$/i.test(predText)) {
        const side = predText === '1' ? 'home' : predText.toUpperCase() === 'X' ? 'draw' : 'away';
        results.push({ pickType: 'moneyline', side: side as Side, value: null, confidence: null });
      }
    }

    return results;
  }

  private probToConfidence(prob: number): Confidence | null {
    if (isNaN(prob)) return null;
    if (prob >= 75) return 'best_bet';
    if (prob >= 60) return 'high';
    if (prob >= 45) return 'medium';
    return 'low';
  }
}
