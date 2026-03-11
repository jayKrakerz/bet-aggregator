import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * FantasyLabs adapter.
 *
 * Scrapes NBA odds/model data from fantasylabs.com.
 * Uses browser fetch since the site is a WordPress/SPA hybrid that
 * loads data dynamically and has various tracking scripts.
 *
 * The /nba/odds/ path now returns 404. Updated to use /nba/
 * which is the main NBA hub. The site may embed data in:
 *   - JSON in `__NEXT_DATA__` or `window.__data__` script tags
 *   - Rendered tables/cards with odds data
 *   - WordPress Yoast-generated content
 */
export class FantasyLabsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'fantasylabs',
    name: 'FantasyLabs',
    baseUrl: 'https://www.fantasylabs.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/nba/',
    },
    cron: '0 0 11,15,19 * * *',
    rateLimitMs: 8000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for content to load
    await page.waitForSelector(
      'table, .game, .matchup, .odds, [class*="game"], [class*="odds"]',
      { timeout: 15000 },
    ).catch(() => {});
    await page.waitForTimeout(4000);
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    // First try to extract JSON data (SPA pattern)
    const jsonPredictions = this.tryParseJsonData(html, sport, fetchedAt);
    if (jsonPredictions.length > 0) return jsonPredictions;

    // Fallback: parse rendered HTML
    return this.parseHtml(html, sport, fetchedAt);
  }

  private tryParseJsonData(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Try __NEXT_DATA__
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch?.[1]) {
      try {
        const data = JSON.parse(nextDataMatch[1]);
        const games = data?.props?.pageProps?.games
          || data?.props?.pageProps?.odds
          || data?.props?.pageProps?.matchups;
        if (Array.isArray(games)) {
          for (const game of games) {
            this.extractFromGameObj(game, predictions, sport, today, fetchedAt);
          }
          return predictions;
        }
      } catch { /* not valid JSON, continue */ }
    }

    // Try window.__data__ or similar embedded JSON
    const dataMatch = html.match(
      /(?:window\.__data__|window\.__STATE__|window\.pageData)\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|$)/,
    );
    if (dataMatch?.[1]) {
      try {
        const data = JSON.parse(dataMatch[1]);
        const games = data?.games || data?.matchups || data?.odds;
        if (Array.isArray(games)) {
          for (const game of games) {
            this.extractFromGameObj(game, predictions, sport, today, fetchedAt);
          }
          return predictions;
        }
      } catch { /* continue to HTML parse */ }
    }

    return predictions;
  }

  private extractFromGameObj(
    game: Record<string, any>,
    predictions: RawPrediction[],
    sport: string,
    today: string,
    fetchedAt: Date,
  ): void {
    const home = game.homeTeam || game.home_team || game.home || game.HomeTeam;
    const away = game.awayTeam || game.away_team || game.away || game.AwayTeam;
    if (!home || !away) return;

    const gameTime = game.gameTime || game.time || game.startTime || null;

    // Spread
    const spread = game.spread || game.line || game.projectedSpread;
    if (spread != null) {
      const spreadVal = typeof spread === 'string' ? parseFloat(spread) : spread;
      if (!isNaN(spreadVal)) {
        const side: Side = spreadVal < 0 ? 'home' : 'away';
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: today,
          gameTime,
          pickType: 'spread',
          side,
          value: Math.abs(spreadVal),
          pickerName: 'FantasyLabs Model',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      }
    }

    // Total
    const total = game.total || game.overUnder || game.projectedTotal;
    if (total != null) {
      const totalVal = typeof total === 'string' ? parseFloat(total) : total;
      if (!isNaN(totalVal)) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: today,
          gameTime,
          pickType: 'over_under',
          side: 'over',
          value: totalVal,
          pickerName: 'FantasyLabs Model',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      }
    }
  }

  private parseHtml(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Check for 404/error pages
    const titleText = $('title').text().toLowerCase();
    if (titleText.includes('not found') || titleText.includes('404') || titleText.includes('error')) {
      return predictions;
    }

    // Try table-based odds layout
    $('table tbody tr').each((_i, el) => {
      const $row = $(el);
      if ($row.find('th').length > 0) return;

      const teams = this.extractTeams($, $row);
      if (!teams) return;

      const { home, away } = teams;
      const gameTime = $row.find('.time, .game-time, .start-time').text().trim() || null;

      // Spread
      const spreadText = $row.find('.spread, .line, .ats, [class*="spread"]').text().trim()
        || $row.find('td').eq(2).text().trim();
      if (spreadText && /[-+]?\d/.test(spreadText)) {
        const value = this.parseSpreadValue(spreadText);
        const side: Side = (value != null && value < 0) ? 'home' : 'away';
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: today,
          gameTime,
          pickType: 'spread',
          side,
          value: value != null ? Math.abs(value) : null,
          pickerName: 'FantasyLabs',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      }

      // Total
      const totalText = $row.find('.total, .ou, .over-under, [class*="total"]').text().trim()
        || $row.find('td').eq(3).text().trim();
      if (totalText && /\d/.test(totalText)) {
        const value = this.parseTotalValue(totalText);
        const ouLower = totalText.toLowerCase();
        const ouSide: Side = ouLower.includes('under') ? 'under' : 'over';
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: today,
          gameTime,
          pickType: 'over_under',
          side: ouSide,
          value,
          pickerName: 'FantasyLabs',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      }
    });

    // Try card-based layout
    if (predictions.length === 0) {
      $('[class*="game"], [class*="matchup"], [class*="card"], [class*="event"]').each((_i, el) => {
        const $card = $(el);
        const text = $card.text();

        const vsMatch = text.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)*)\s+(?:@|vs\.?|at)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)*)/);
        if (!vsMatch) return;

        const away = vsMatch[1]!.trim();
        const home = vsMatch[2]!.trim();

        // Extract spread values
        const spreadMatch = text.match(/([+-]\d+\.?\d*)/);
        if (spreadMatch) {
          const spreadVal = parseFloat(spreadMatch[1]!);
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: home,
            awayTeamRaw: away,
            gameDate: today,
            gameTime: null,
            pickType: 'spread',
            side: spreadVal < 0 ? 'home' : 'away',
            value: Math.abs(spreadVal),
            pickerName: 'FantasyLabs',
            confidence: null,
            reasoning: null,
            fetchedAt,
          });
        }
      });
    }

    return predictions;
  }

  private extractTeams(
    $: ReturnType<typeof this.load>,
    $row: ReturnType<ReturnType<typeof this.load>>,
  ): { home: string; away: string } | null {
    const teamEls = $row.find('.team-name, .team, td.team, .team-label, a.team, [class*="team"]');
    if (teamEls.length >= 2) {
      return {
        away: teamEls.eq(0).text().trim(),
        home: teamEls.eq(1).text().trim(),
      };
    }

    const cells = $row.find('td');
    for (let i = 0; i < Math.min(cells.length, 3); i++) {
      const text = $(cells[i]).text().trim();
      const vsMatch = text.match(/^(.+?)\s+(?:@|vs\.?|at)\s+(.+?)$/i);
      if (vsMatch) {
        return { away: vsMatch[1]!.trim(), home: vsMatch[2]!.trim() };
      }
    }

    return null;
  }
}
