import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * RotoWire NBA adapter.
 *
 * Scrapes NBA betting picks from rotowire.com.
 * RotoWire publishes expert consensus picks with ATS, O/U, and ML picks.
 *
 * The /betting/nba/picks.php path now returns 404.
 * Updated to use /betting/nba/ which is the main NBA betting hub.
 * Uses browser fetch because the site has anti-bot protection
 * (html-load.com script) and loads content dynamically.
 *
 * Expected structure after browser render:
 * - Table rows or card-based layouts for picks
 * - Expert/consensus picks with team matchups
 * - Spread, O/U, and ML columns
 */
export class RotowireNbaAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'rotowire-nba',
    name: 'RotoWire NBA',
    baseUrl: 'https://www.rotowire.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/betting/nba/',
    },
    cron: '0 0 10,14,18,21 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for content to load past anti-bot protection
    await page.waitForSelector(
      'table, .pick, .game, .matchup, .betting, [class*="pick"], [class*="game"]',
      { timeout: 20000 },
    ).catch(() => {});
    await page.waitForTimeout(4000);
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Check if page is a 404 or error page
    const pageText = $('main, .page, #content, body').text().toLowerCase();
    if (pageText.includes('page not found') || pageText.includes('not found') || pageText.includes('404')) {
      return predictions;
    }

    // Strategy 1: Table-based layout
    $('table tbody tr').each((_i, el) => {
      const $row = $(el);
      if ($row.find('th').length > 0) return;

      const teams = this.extractTeamsFromRow($, $row);
      if (!teams) return;

      const { home, away } = teams;
      const gameTime = $row.find('.time, .game-time, td:first-child').text().trim() || null;
      const pickerName = $row.find('.expert, .analyst, .author').text().trim() || 'RotoWire';

      // ATS pick
      const spreadText = $row.find('.ats, .spread, [class*="spread"], [class*="ats"]').text().trim()
        || $row.find('td').eq(2).text().trim();
      if (spreadText && /[-+]?\d/.test(spreadText)) {
        const side = this.resolveSide(spreadText, home, away);
        const value = this.parseSpreadValue(spreadText);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: today,
          gameTime,
          pickType: 'spread',
          side,
          value,
          pickerName,
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      }

      // O/U pick
      const ouText = $row.find('.ou, .total, [class*="total"], [class*="over"]').text().trim()
        || $row.find('td').eq(3).text().trim();
      if (ouText && /\d/.test(ouText)) {
        const ouLower = ouText.toLowerCase();
        const ouSide: Side = ouLower.includes('under') ? 'under' : 'over';
        const value = this.parseTotalValue(ouText);
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
          pickerName,
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      }

      // ML pick
      const mlText = $row.find('.ml, .moneyline, [class*="money"], [class*="ml"]').text().trim()
        || $row.find('td').eq(4).text().trim();
      if (mlText && /[-+]?\d/.test(mlText)) {
        const side = this.resolveSide(mlText, home, away);
        const value = this.parseMoneylineValue(mlText);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: today,
          gameTime,
          pickType: 'moneyline',
          side,
          value,
          pickerName,
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      }
    });

    // Strategy 2: Card/article-based layout
    if (predictions.length === 0) {
      $('[class*="pick"], [class*="game"], [class*="card"], article').each((_i, el) => {
        const $card = $(el);
        const text = $card.text();

        // Look for "away @ home" or "away vs home" patterns
        const vsMatch = text.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)*)\s+(?:@|vs\.?|at)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)*)/);
        if (!vsMatch) return;

        const away = vsMatch[1]!.trim();
        const home = vsMatch[2]!.trim();

        const pickText = $card.find('strong, b, .pick, .winner, .selection').first().text().trim();
        if (!pickText) return;

        const side = this.resolveSide(pickText, home, away);
        const cardText = text.toLowerCase();
        const pickType = this.inferPickType(cardText);
        const pickerName = $card.find('.author, .expert, .analyst').text().trim() || 'RotoWire';
        const reasoning = $card.find('p').first().text().trim().slice(0, 300) || null;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: today,
          gameTime: null,
          pickType,
          side,
          value: null,
          pickerName,
          confidence: null,
          reasoning,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private extractTeamsFromRow(
    $: ReturnType<typeof this.load>,
    $row: ReturnType<ReturnType<typeof this.load>>,
  ): { home: string; away: string } | null {
    // Try team-specific elements
    const teamEls = $row.find('.team-name, .team, td.team, .teams a, [class*="team"]');
    if (teamEls.length >= 2) {
      return {
        away: teamEls.eq(0).text().trim(),
        home: teamEls.eq(1).text().trim(),
      };
    }

    // Try matchup cell text
    const cells = $row.find('td');
    for (let i = 0; i < Math.min(cells.length, 3); i++) {
      const cellText = $(cells[i]).text().trim();
      const vsMatch = cellText.match(/^(.+?)\s+(?:@|vs\.?|at)\s+(.+?)$/i);
      if (vsMatch) {
        return { away: vsMatch[1]!.trim(), home: vsMatch[2]!.trim() };
      }
    }

    return null;
  }

  private resolveSide(pick: string, home: string, away: string): Side {
    const pLower = pick.toLowerCase();
    if (pLower.includes('over')) return 'over';
    if (pLower.includes('under')) return 'under';
    const hLower = home.toLowerCase();
    const aLower = away.toLowerCase();
    if (pLower.includes(hLower) || hLower.includes(pLower)) return 'home';
    if (pLower.includes(aLower) || aLower.includes(pLower)) return 'away';
    return 'home';
  }
}
