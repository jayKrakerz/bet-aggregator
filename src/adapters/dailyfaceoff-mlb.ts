import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Daily Faceoff MLB adapter.
 *
 * Daily Faceoff is primarily an NHL site. The /mlb-predictions/ path
 * returns 404. Updated to use /betting/mlb-picks/ which may exist
 * during MLB season. Uses browser fetch since the site is a Next.js app.
 *
 * The site uses Next.js with __NEXT_DATA__ for SSR data, so we try
 * to extract data from both the JSON payload and rendered HTML.
 *
 * If the page returns 404, the adapter will return an empty array gracefully.
 */
export class DailyFaceoffMlbAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'dailyfaceoff-mlb',
    name: 'Daily Faceoff MLB',
    baseUrl: 'https://www.dailyfaceoff.com',
    fetchMethod: 'browser',
    paths: {
      mlb: '/betting/mlb-picks/',
    },
    cron: '0 0 10,14,18 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector(
      'table, .pick, .game, .matchup, [class*="pick"], [class*="game"]',
      { timeout: 15000 },
    ).catch(() => {});
    await page.waitForTimeout(3000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Check for 404 page - Daily Faceoff shows a 404 gif and message
    const pageText = $('section, main, .page, body').text().toLowerCase();
    if (
      pageText.includes("doesn't exist") ||
      pageText.includes('not found') ||
      pageText.includes('404')
    ) {
      return predictions;
    }

    // Try to extract data from __NEXT_DATA__ (Next.js SSR)
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch?.[1]) {
      try {
        const data = JSON.parse(nextDataMatch[1]);
        // Check if it's a 404 page via Next.js data
        if (data?.page === '/404') {
          return predictions;
        }
        const picks = data?.props?.pageProps?.picks
          || data?.props?.pageProps?.predictions
          || data?.props?.pageProps?.games;
        if (Array.isArray(picks)) {
          for (const pick of picks) {
            this.extractFromPickObj(pick, predictions, sport, today, fetchedAt);
          }
          if (predictions.length > 0) return predictions;
        }
      } catch { /* continue to HTML parsing */ }
    }

    // Fallback: parse rendered HTML
    // Try card-based layout (common for prediction sites)
    $('[class*="pick"], [class*="game"], [class*="prediction"], [class*="matchup"], article').each((_i, el) => {
      const $card = $(el);
      const text = $card.text();

      // Look for team matchup patterns
      const vsMatch = text.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)*)\s+(?:@|vs\.?|at)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)*)/);
      if (!vsMatch) return;

      const away = vsMatch[1]!.trim();
      const home = vsMatch[2]!.trim();

      // Try to find pick/selection
      const pickText = $card.find('strong, b, .pick, .winner, .selection, [class*="pick"]').first().text().trim();
      if (!pickText) return;

      const side = this.resolveSide(pickText, home, away);
      const cardText = text.toLowerCase();
      const pickType = this.inferPickType(cardText);
      const pickerName = $card.find('.author, .analyst, .expert, [class*="author"]').text().trim() || 'Daily Faceoff';
      const reasoning = $card.find('p').first().text().trim().slice(0, 300) || null;

      let value: number | null = null;
      if (pickType === 'spread') {
        const spreadMatch = text.match(/([+-]\d+\.?\d*)/);
        value = spreadMatch ? parseFloat(spreadMatch[1]!) : null;
      } else if (pickType === 'over_under') {
        const totalMatch = text.match(/(\d+\.?\d*)\s*(?:runs|total)/i);
        value = totalMatch ? parseFloat(totalMatch[1]!) : null;
      }

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: home,
        awayTeamRaw: away,
        gameDate: today,
        gameTime: null,
        pickType,
        side,
        value,
        pickerName,
        confidence: null,
        reasoning,
        fetchedAt,
      });
    });

    // Try table-based layout
    if (predictions.length === 0) {
      $('table tbody tr').each((_i, el) => {
        const $row = $(el);
        if ($row.find('th').length > 0) return;

        const cells = $row.find('td');
        if (cells.length < 2) return;

        // Try to extract team matchup from first cells
        const matchupText = cells.eq(0).text().trim() + ' ' + cells.eq(1).text().trim();
        const vsMatch = matchupText.match(/(.+?)\s+(?:@|vs\.?|at)\s+(.+?)(?:\s|$)/i);
        if (!vsMatch) return;

        const away = vsMatch[1]!.trim();
        const home = vsMatch[2]!.trim();

        // Pick from remaining cells
        const pickCell = cells.eq(2).text().trim() || cells.eq(1).text().trim();
        const side = this.resolveSide(pickCell, home, away);

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
          pickerName: 'Daily Faceoff',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private extractFromPickObj(
    pick: Record<string, any>,
    predictions: RawPrediction[],
    sport: string,
    today: string,
    fetchedAt: Date,
  ): void {
    const home = pick.homeTeam || pick.home_team || pick.home;
    const away = pick.awayTeam || pick.away_team || pick.away;
    if (!home || !away) return;

    const gameTime = pick.gameTime || pick.time || pick.startTime || null;
    const pickText = pick.pick || pick.selection || pick.winner || '';
    const side = this.resolveJsonSide(pickText, home, away);

    predictions.push({
      sourceId: this.config.id,
      sport,
      homeTeamRaw: home,
      awayTeamRaw: away,
      gameDate: today,
      gameTime,
      pickType: 'moneyline',
      side,
      value: null,
      pickerName: pick.expert || pick.author || 'Daily Faceoff',
      confidence: null,
      reasoning: pick.analysis || pick.reasoning || null,
      fetchedAt,
    });
  }

  private resolveJsonSide(pick: string, home: string, away: string): Side {
    const pLower = (pick || '').toLowerCase();
    const hLower = home.toLowerCase();
    const aLower = away.toLowerCase();
    if (pLower.includes(hLower) || hLower.includes(pLower)) return 'home';
    if (pLower.includes(aLower) || aLower.includes(pLower)) return 'away';
    return 'home';
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
