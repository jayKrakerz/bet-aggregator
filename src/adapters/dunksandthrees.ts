import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Dunks and Threes adapter.
 *
 * Scrapes NBA model-based predictions from dunksandthrees.com.
 * The site is a SvelteKit SPA that loads data client-side.
 * The /nba-models/ path requires authentication, so we use /games
 * which shows today's NBA games with projected scores publicly.
 *
 * Requires browser fetch since content is rendered client-side.
 *
 * Expected rendered structure (SvelteKit app):
 *   - Game containers are rendered in a table or list
 *   - Uses Svelte component classes like `svelte-XXXXXX`
 *   - Team names with links to /teams/{id}
 *   - Projected scores, spreads, win probabilities
 */
export class DunksAndThreesAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'dunksandthrees',
    name: 'Dunks and Threes',
    baseUrl: 'https://dunksandthrees.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/games',
    },
    cron: '0 0 10,15,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for game data to render in the SvelteKit SPA
    await page.waitForSelector('table, .game, [class*="game"], [class*="matchup"]', {
      timeout: 15000,
    }).catch(() => {});
    await page.waitForTimeout(3000);
    // Scroll to load all content
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Strategy 1: Look for table rows with team data
    // Dunks & Threes renders games in tables with team names and projected scores
    $('table tbody tr, table tr').each((_i, el) => {
      const $row = $(el);
      // Skip header rows
      if ($row.find('th').length > 0) return;

      const cells = $row.find('td');
      if (cells.length < 3) return;

      // Try to extract teams from links to /teams/ or text content
      const teamLinks = $row.find('a[href*="/teams/"]');
      if (teamLinks.length >= 2) {
        const away = teamLinks.eq(0).text().trim();
        const home = teamLinks.eq(1).text().trim();
        if (!away || !home) return;

        // Extract numeric values from cells (projected scores, spread, etc.)
        const numbers: number[] = [];
        cells.each((_j, cell) => {
          const text = $(cell).text().trim();
          const num = parseFloat(text);
          if (!isNaN(num) && num > 0) {
            numbers.push(num);
          }
        });

        // If we have projected scores (typically two numbers around 100-130 for NBA)
        const scores = numbers.filter(n => n >= 70 && n <= 170);
        let awayScore = NaN;
        let homeScore = NaN;
        if (scores.length >= 2) {
          awayScore = scores[0]!;
          homeScore = scores[1]!;
        }

        // Win probability (0-100 range)
        const probs = numbers.filter(n => n > 0 && n <= 100 && !scores.includes(n));
        const winProb = probs.length > 0 ? probs[0]! : NaN;
        const confidence = this.mapProbToConfidence(winProb);

        // Compute spread from projected scores
        const spread = !isNaN(homeScore) && !isNaN(awayScore)
          ? Math.round((homeScore - awayScore) * 10) / 10
          : null;

        const total = !isNaN(homeScore) && !isNaN(awayScore)
          ? Math.round((homeScore + awayScore) * 10) / 10
          : null;

        const side: Side = spread != null && spread > 0 ? 'home' : 'away';
        const reasoning = this.buildReasoning(homeScore, awayScore, home, away);

        // Spread prediction
        if (spread != null) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: home,
            awayTeamRaw: away,
            gameDate: today,
            gameTime: null,
            pickType: 'spread',
            side,
            value: Math.abs(spread),
            pickerName: 'Dunks & Threes Model',
            confidence,
            reasoning,
            fetchedAt,
          });
        }

        // Over/under prediction
        if (total != null) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: home,
            awayTeamRaw: away,
            gameDate: today,
            gameTime: null,
            pickType: 'over_under',
            side: 'over',
            value: total,
            pickerName: 'Dunks & Threes Model',
            confidence,
            reasoning,
            fetchedAt,
          });
        }

        // Moneyline pick
        if (spread != null) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: home,
            awayTeamRaw: away,
            gameDate: today,
            gameTime: null,
            pickType: 'moneyline',
            side,
            value: null,
            pickerName: 'Dunks & Threes Model',
            confidence,
            reasoning,
            fetchedAt,
          });
        }
      }
    });

    // Strategy 2: Look for game cards/containers with data attributes or text
    if (predictions.length === 0) {
      // Try parsing matchup text patterns like "Team1 vs Team2" or "Team1 @ Team2"
      $('[class*="game"], [class*="matchup"], [class*="card"]').each((_i, el) => {
        const $el = $(el);
        const text = $el.text();

        // Look for "away @ home" or "away vs home" patterns
        const vsMatch = text.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)*)\s+(?:@|vs\.?|at)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)*)/);
        if (!vsMatch) return;

        const away = vsMatch[1]!.trim();
        const home = vsMatch[2]!.trim();

        // Extract projected scores (numbers around 90-140)
        const scoreMatches = text.match(/\b(1?\d{2}(?:\.\d)?)\b/g);
        const scores = (scoreMatches || [])
          .map(s => parseFloat(s))
          .filter(n => n >= 70 && n <= 170);

        if (scores.length >= 2) {
          const awayScore = scores[0]!;
          const homeScore = scores[1]!;
          const spread = Math.round((homeScore - awayScore) * 10) / 10;
          const total = Math.round((homeScore + awayScore) * 10) / 10;
          const side: Side = spread > 0 ? 'home' : 'away';
          const reasoning = this.buildReasoning(homeScore, awayScore, home, away);

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: home,
            awayTeamRaw: away,
            gameDate: today,
            gameTime: null,
            pickType: 'moneyline',
            side,
            value: null,
            pickerName: 'Dunks & Threes Model',
            confidence: null,
            reasoning,
            fetchedAt,
          });
        }
      });
    }

    return predictions;
  }

  private mapProbToConfidence(pct: number): 'best_bet' | 'high' | 'medium' | 'low' | null {
    if (isNaN(pct)) return null;
    if (pct >= 75) return 'best_bet';
    if (pct >= 65) return 'high';
    if (pct >= 55) return 'medium';
    return 'low';
  }

  private buildReasoning(
    homeScore: number,
    awayScore: number,
    home: string,
    away: string,
  ): string | null {
    if (isNaN(homeScore) || isNaN(awayScore)) return null;
    return `Projected: ${away} ${awayScore} @ ${home} ${homeScore}`;
  }
}
