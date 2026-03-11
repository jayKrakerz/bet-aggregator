import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * CBS SportsLine NBA adapter.
 *
 * STATUS: NOT WORKING (404) - As of 2026-03-10, the /nba/expert-picks/
 * URL returns HTTP 404. The `__NEXT_DATA__` contains `pageProps.name`
 * matching the URL path and `initialState` but no actual picks data.
 * The body shows "loading..." text, suggesting the route is invalid
 * or has been moved.
 *
 * When working, SportsLine uses `[data-testid="TeamMatchupCard"]`
 * article elements similar to the MLB adapter, with:
 *   - `[data-testid="TeamMatchupCard-data"]` for game time
 *   - `[data-testid="teamMatchupTestId-matchup"]` for "TEAM1 vs TEAM2 +/-spread"
 *   - `[data-testid="TeamMatchupCard-experts"]` for expert pick details
 *   - Styled-components classes (sc-* prefixed, hashed)
 *
 * Try /nba/picks/ or /nba/picks/experts/ as alternative paths.
 */
export class SportslineNbaAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'sportsline-nba',
    name: 'SportsLine NBA',
    baseUrl: 'https://www.sportsline.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/nba/expert-picks/',
    },
    cron: '0 0 9,15,21 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 6000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for Next.js hydration and content to load
    await page.waitForSelector('[data-testid="TeamMatchupCard"], article, .picks-card', {
      timeout: 15000,
    }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    // Try __NEXT_DATA__ for expertPicksContainerProps (same pattern as MLB adapter)
    const nextData = $('script#__NEXT_DATA__').html();
    if (nextData) {
      try {
        const data = JSON.parse(nextData);
        const epc = data?.props?.pageProps?.expertPicksContainerProps;
        const edges = epc?.data?.expertPicks?.edges || [];
        for (const edge of edges) {
          const node = edge?.node;
          if (!node) continue;
          const homeTeamRaw = node.homeTeam?.name || node.homeTeam?.abbreviation || '';
          const awayTeamRaw = node.awayTeam?.name || node.awayTeam?.abbreviation || '';
          if (!homeTeamRaw || !awayTeamRaw) continue;
          const pickText = node.pick || node.pickType || '';
          const pickType = this.inferPickType(pickText);
          let side: Side = 'home';
          let value: number | null = null;
          if (pickType === 'over_under') {
            side = pickText.toLowerCase().includes('under') ? 'under' : 'over';
            value = this.parseTotalValue(pickText);
          } else if (pickType === 'spread') {
            value = this.parseSpreadValue(pickText);
            side = this.resolveTeamSide(pickText, awayTeamRaw, homeTeamRaw);
          } else {
            side = this.resolveTeamSide(pickText, awayTeamRaw, homeTeamRaw);
          }
          predictions.push({
            sourceId: this.config.id, sport, homeTeamRaw, awayTeamRaw,
            gameDate: node.gameDate || todayStr,
            gameTime: node.gameTime || null,
            pickType, side, value,
            pickerName: node.expert?.name || 'SportsLine Model',
            confidence: this.parseConfidenceScore(node.confidence || node.units || ''),
            reasoning: (node.analysis || pickText).slice(0, 300) || null,
            fetchedAt,
          });
        }
        if (predictions.length > 0) return predictions;
      } catch { /* fall through */ }
    }

    // Parse TeamMatchupCard elements (data-testid-based selectors)
    // SportsLine uses styled-components with hashed class names, so
    // data-testid attributes are the reliable selectors.
    $('[data-testid="TeamMatchupCard"]').each((_i, el) => {
      const $card = $(el);

      // Game time from data section
      const timeText = $card.find('[data-testid="TeamMatchupCard-data"]').text().trim();
      const timeMatch = timeText.match(/(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?\s*(?:GMT|ET|CT|PT)?)/);
      const gameTime = timeMatch ? timeMatch[1]!.trim() : null;

      // Matchup text like "TEAM1 vs TEAM2 +/-spread"
      const matchupText = $card.find('[data-testid="teamMatchupTestId-matchup"]').text().trim();
      const vsMatch = matchupText.match(/^(.+?)\s+vs\s+(.+?)(?:\s+([+-][\d.]+))?$/i);
      if (!vsMatch) return;

      const awayTeamRaw = vsMatch[1]!.trim();
      const homeRawWithSpread = vsMatch[2]!.trim();
      // Home team may have spread attached, split it off
      const spreadMatch = homeRawWithSpread.match(/^(.+?)\s+([+-][\d.]+)$/);
      const homeTeamRaw = spreadMatch ? spreadMatch[1]!.trim() : homeRawWithSpread;
      const spreadVal = spreadMatch ? parseFloat(spreadMatch[2]!) : (vsMatch[3] ? parseFloat(vsMatch[3]) : null);

      if (!homeTeamRaw || !awayTeamRaw) return;

      // Default to spread if we found a spread value
      const pickType = spreadVal !== null ? 'spread' as const : 'moneyline' as const;
      const side: Side = 'home';

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate: todayStr,
        gameTime,
        pickType,
        side,
        value: spreadVal,
        pickerName: 'SportsLine',
        confidence: null,
        reasoning: matchupText.slice(0, 300) || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private resolveTeamSide(text: string, away: string, home: string): Side {
    const lower = text.toLowerCase();
    const awayLast = away.toLowerCase().split(' ').pop()!;
    const homeLast = home.toLowerCase().split(' ').pop()!;
    if (lower.includes(awayLast)) return 'away';
    if (lower.includes(homeLast)) return 'home';
    return 'home';
  }

  /** Parse confidence from unit ratings (e.g., "3 units", "5 stars"). */
  private parseConfidenceScore(text: string): 'low' | 'medium' | 'high' | 'best_bet' | null {
    if (!text) return null;
    const num = parseFloat(text.replace(/[^\d.]/g, ''));
    if (isNaN(num)) return this.inferConfidence(text);
    // Assuming 1-5 scale
    if (num >= 5) return 'best_bet';
    if (num >= 4) return 'high';
    if (num >= 2) return 'medium';
    return 'low';
  }

}
