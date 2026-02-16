import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Dimers adapter.
 *
 * Dimers is an Angular SPA that runs 10K Monte Carlo simulations for each game.
 * Requires browser rendering for Angular hydration.
 *
 * Page structure:
 *   - `.games-container` — list of game cards
 *   - `.game-card` — one per game
 *     - `.away-team .team-name` / `.home-team .team-name` — team names
 *     - `.win-probability .away-prob .prob-value` / `.home-prob .prob-value` — win %
 *     - `.predicted-score .away-score` / `.home-score` — predicted final score
 *     - `.betting-edges .edge-row` — spread, total, ML edges
 *       - `.edge-pick` — recommended pick
 *       - `.edge-direction` — "home" | "away" | "over" | "under" | "push"
 *       - `.edge-value` — edge magnitude (positive = value)
 *       - `.current-line` — current market line
 *       - `.dimers-line` — Dimers predicted line
 *     - `.game-detail-link` — link to full analysis page
 *
 * Games with status "Final" are skipped.
 */
export class DimersAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'dimers',
    name: 'Dimers',
    baseUrl: 'https://www.dimers.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/bet-hub/nba/schedule',
      nfl: '/bet-hub/nfl/schedule',
      mlb: '/bet-hub/mlb/schedule',
      nhl: '/bet-hub/nhl/schedule',
    },
    cron: '0 0 9,13,17,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('.game-card, .games-container', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  discoverUrls(html: string, _sport: string): string[] {
    const $ = this.load(html);
    const urls: string[] = [];

    $('a.game-detail-link').each((_i, el) => {
      const href = $(el).attr('href');
      if (href) {
        const url = href.startsWith('http') ? href : `${this.config.baseUrl}${href}`;
        urls.push(url);
      }
    });

    return urls;
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    const dateText = $('.selected-date').attr('data-date') || $('.selected-date').text().trim();
    const gameDate = this.parseDateValue(dateText, fetchedAt);

    $('.game-card').each((_i, el) => {
      const card = $(el);

      // Skip completed games
      const status = card.find('.game-status').text().trim().toLowerCase();
      if (status === 'final' || status === 'completed') return;

      const awayTeamRaw = card.find('.away-team .team-name').text().trim();
      const homeTeamRaw = card.find('.home-team .team-name').text().trim();
      const gameTime = card.find('.game-time').text().trim() || null;

      if (!awayTeamRaw || !homeTeamRaw) return;
      if (gameTime?.toLowerCase() === 'final') return;

      // Win probabilities
      const awayProb = this.parseProb(card.find('.away-prob .prob-value').text());
      const homeProb = this.parseProb(card.find('.home-prob .prob-value').text());

      // Predicted score
      const awayScore = parseInt(card.find('.predicted-score .away-score').text().trim(), 10);
      const homeScore = parseInt(card.find('.predicted-score .home-score').text().trim(), 10);
      const hasScore = !isNaN(awayScore) && !isNaN(homeScore);

      const reasoning = this.buildReasoning(awayTeamRaw, homeTeamRaw, awayScore, homeScore, awayProb, homeProb);

      // Parse edge rows
      card.find('.edge-row').each((_j, edgeEl) => {
        const edge = $(edgeEl);
        const direction = edge.find('.edge-direction').text().trim().toLowerCase();
        const edgeValue = edge.find('.edge-value').text().trim();
        const currentLine = edge.find('.current-line').text().trim();

        // Skip push/no-edge picks
        if (direction === 'push' || !direction) return;

        if (edge.hasClass('spread-edge')) {
          const side: Side = direction === 'home' ? 'home' : 'away';
          const spreadVal = this.extractSpread(currentLine);

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'spread',
            side,
            value: spreadVal,
            pickerName: 'Dimers Model',
            confidence: this.mapEdgeToConfidence(edgeValue),
            reasoning: reasoning ? `${reasoning} | Edge: ${edgeValue}` : `Edge: ${edgeValue}`,
            fetchedAt,
          });
        } else if (edge.hasClass('total-edge')) {
          const side: Side = direction as Side;
          if (side !== 'over' && side !== 'under') return;

          const totalVal = parseFloat(currentLine);

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'over_under',
            side,
            value: isNaN(totalVal) ? null : totalVal,
            pickerName: 'Dimers Model',
            confidence: this.mapEdgeToConfidence(edgeValue),
            reasoning: reasoning
              ? `${reasoning} | Predicted total: ${hasScore ? awayScore + homeScore : 'N/A'} | Edge: ${edgeValue}`
              : `Edge: ${edgeValue}`,
            fetchedAt,
          });
        } else if (edge.hasClass('ml-edge')) {
          const side: Side = direction === 'home' ? 'home' : 'away';
          const mlOdds = this.extractMlOdds(currentLine);

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'moneyline',
            side,
            value: mlOdds,
            pickerName: 'Dimers Model',
            confidence: this.mapWinProbToConfidence(side === 'away' ? awayProb : homeProb),
            reasoning: reasoning
              ? `${reasoning} | Win prob: ${side === 'away' ? awayProb : homeProb}% | Edge: ${edgeValue}`
              : `Edge: ${edgeValue}`,
            fetchedAt,
          });
        }
      });
    });

    return predictions;
  }

  private parseProb(text: string): number | null {
    const match = text.match(/([\d.]+)/);
    return match ? parseFloat(match[1]!) : null;
  }

  private extractSpread(lineText: string): number | null {
    // "BOS -6.5" → -6.5
    const match = lineText.match(/([+-]?\d+\.?\d*)/);
    return match ? parseFloat(match[1]!) : null;
  }

  private extractMlOdds(lineText: string): number | null {
    // "BOS -280" → -280
    const match = lineText.match(/([+-]?\d+)/);
    return match ? parseInt(match[1]!, 10) : null;
  }

  private mapEdgeToConfidence(edgeText: string): Confidence | null {
    const match = edgeText.match(/([+-]?[\d.]+)/);
    if (!match) return null;
    const edge = Math.abs(parseFloat(match[1]!));
    if (edge >= 5) return 'best_bet';
    if (edge >= 3) return 'high';
    if (edge >= 1) return 'medium';
    return 'low';
  }

  private mapWinProbToConfidence(prob: number | null): Confidence | null {
    if (prob == null) return null;
    if (prob >= 75) return 'best_bet';
    if (prob >= 65) return 'high';
    if (prob >= 55) return 'medium';
    return 'low';
  }

  private buildReasoning(
    awayTeam: string,
    homeTeam: string,
    awayScore: number,
    homeScore: number,
    awayProb: number | null,
    homeProb: number | null,
  ): string | null {
    const parts: string[] = [];
    if (!isNaN(awayScore) && !isNaN(homeScore)) {
      parts.push(`Predicted: ${awayTeam} ${awayScore}, ${homeTeam} ${homeScore}`);
    }
    if (awayProb != null && homeProb != null) {
      parts.push(`Win prob: ${awayTeam} ${awayProb}%, ${homeTeam} ${homeProb}%`);
    }
    return parts.length > 0 ? parts.join(' | ') : null;
  }

  private parseDateValue(text: string, fetchedAt: Date): string {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

    // "Feb 16, 2026" or "February 16, 2026"
    const match = text.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (match) {
      const months: Record<string, string> = {
        jan: '01', feb: '02', mar: '03', apr: '04',
        may: '05', jun: '06', jul: '07', aug: '08',
        sep: '09', oct: '10', nov: '11', dec: '12',
        january: '01', february: '02', march: '03', april: '04',
        june: '06', july: '07', august: '08',
        september: '09', october: '10', november: '11', december: '12',
      };
      const m = months[match[1]!.toLowerCase()];
      if (m) {
        const d = match[2]!.padStart(2, '0');
        return `${match[3]}-${m}-${d}`;
      }
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
