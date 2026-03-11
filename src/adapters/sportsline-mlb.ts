import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * SportsLine MLB adapter.
 *
 * STATUS: PARTIALLY WORKING - Page loads via browser with `__NEXT_DATA__`
 * containing `expertPicksContainerProps.data.expertPicks.edges` (GraphQL).
 * As of 2026-03-10 (pre-season), edges array is empty (0 picks).
 * Also has `[data-testid="TeamMatchupCard"]` article elements in the DOM
 * with `teamMatchupTestId-matchup` text like "TEAM1 vs TEAM2 +/-spread"
 * and `TeamMatchupCard-data` for game time.
 * Both __NEXT_DATA__ and DOM parsing should produce results once MLB
 * regular season starts (late March).
 */
export class SportslineMlbAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'sportsline-mlb',
    name: 'SportsLine MLB',
    baseUrl: 'https://www.sportsline.com',
    fetchMethod: 'browser',
    paths: {
      mlb: '/mlb/picks/experts/',
    },
    cron: '0 0 10,15,19 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 8000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Strategy 1: Extract from __NEXT_DATA__ expertPicksContainerProps (GraphQL)
    const nextData = $('script#__NEXT_DATA__').html();
    if (nextData) {
      try {
        const data = JSON.parse(nextData);

        // Try expertPicksContainerProps.data.expertPicks.edges
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
          const side = this.resolveSide(pickText, homeTeamRaw, awayTeamRaw);
          let value: number | null = null;
          if (pickType === 'spread') value = this.parseSpreadValue(pickText);
          else if (pickType === 'over_under') value = this.parseTotalValue(pickText);

          predictions.push({
            sourceId: this.config.id, sport, homeTeamRaw, awayTeamRaw,
            gameDate: node.gameDate || today,
            gameTime: node.gameTime || null,
            pickType, side, value,
            pickerName: node.expert?.name || 'SportsLine',
            confidence: this.inferConfidence(node.confidence || ''),
            reasoning: (node.analysis || pickText).slice(0, 300) || null,
            fetchedAt,
          });
        }
        if (predictions.length > 0) return predictions;

        // Fallback: try legacy picks/expertPicks pattern
        const legacyPicks = this.extractFromNextData(data, sport, today, fetchedAt);
        if (legacyPicks.length > 0) return legacyPicks;
      } catch { /* fall through to HTML parsing */ }
    }

    // Strategy 2: Parse TeamMatchupCard elements (data-testid-based)
    // SportsLine uses styled-components with hashed sc-* class names.
    // data-testid attributes are the stable selectors.
    $('[data-testid="TeamMatchupCard"]').each((_i, el) => {
      const $card = $(el);

      // Game time
      const timeText = $card.find('[data-testid="TeamMatchupCard-data"]').text().trim();
      const timeMatch = timeText.match(/(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?\s*(?:GMT|ET|CT|PT)?)/);
      const gameTime = timeMatch ? timeMatch[1]!.trim() : null;

      // Matchup: "TEAM1 vs TEAM2 +/-spread"
      const matchupText = $card.find('[data-testid="teamMatchupTestId-matchup"]').text().trim();
      const vsMatch = matchupText.match(/^(.+?)\s+vs\s+(.+?)$/i);
      if (!vsMatch) return;

      const awayRaw = vsMatch[1]!.trim();
      const homeRawFull = vsMatch[2]!.trim();
      // Home team may have spread attached
      const spreadMatch = homeRawFull.match(/^(.+?)\s+([+-][\d.]+)$/);
      const homeTeamRaw = spreadMatch ? spreadMatch[1]!.trim() : homeRawFull;
      const spreadVal = spreadMatch ? parseFloat(spreadMatch[2]!) : null;

      if (!homeTeamRaw || !awayRaw) return;

      const pickType = spreadVal !== null ? 'spread' as const : 'moneyline' as const;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw: awayRaw,
        gameDate: today,
        gameTime,
        pickType,
        side: 'home',
        value: spreadVal,
        pickerName: 'SportsLine',
        confidence: null,
        reasoning: matchupText.slice(0, 300) || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseMatchup(text: string): { home: string; away: string } | null {
    const match = text.match(/^(.+?)\s+(?:@|vs\.?|at)\s+(.+?)$/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
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

  /**
   * Extract picks from __NEXT_DATA__ GraphQL structure.
   *
   * Data is in `pageProps.expertPicksContainerProps` with:
   *   - `.data.expertPicks.edges[].node` for current/upcoming picks
   *   - `.pastData.expertPicks.edges[].node` for recent past picks
   * Each node: { game, expert, selection, unit, resultStatus, writeup, locked }
   *   game: { abbrev, scheduledTime, homeTeam: { nickname, mediumName }, awayTeam }
   *   expert: { firstName, lastName, nickName }
   *   selection: { label, subLabel, marketType, odds, side, value }
   */
  private extractFromNextData(
    data: any,
    sport: string,
    today: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];
    try {
      const props = data?.props?.pageProps;
      const epc = props?.expertPicksContainerProps;
      if (!epc) return predictions;

      // Combine current and past picks
      const currentEdges = epc?.data?.expertPicks?.edges || [];
      const pastEdges = epc?.pastData?.expertPicks?.edges || [];
      const allEdges = [...currentEdges, ...pastEdges];

      for (const edge of allEdges) {
        const node = edge?.node;
        if (!node || node.locked) continue;

        const game = node.game;
        const expert = node.expert;
        const selection = node.selection;
        if (!game?.homeTeam || !game?.awayTeam) continue;

        const homeTeamRaw = game.homeTeam.nickname || game.homeTeam.mediumName || '';
        const awayTeamRaw = game.awayTeam.nickname || game.awayTeam.mediumName || '';
        if (!homeTeamRaw || !awayTeamRaw) continue;

        // Parse game date from scheduledTime
        let gameDate = today;
        let gameTime: string | null = null;
        if (game.scheduledTime) {
          const d = new Date(game.scheduledTime);
          gameDate = d.toISOString().split('T')[0]!;
          const hours = d.getUTCHours();
          const mins = d.getUTCMinutes();
          const period = hours >= 12 ? 'PM' : 'AM';
          const h = hours % 12 || 12;
          gameTime = `${h}:${mins.toString().padStart(2, '0')} ${period}`;
        }

        // Determine pick type from selection.marketType
        const marketType = selection?.marketType || '';
        let pickType: 'moneyline' | 'spread' | 'over_under' = 'moneyline';
        if (marketType === 'SPREAD' || marketType === 'AGAINST_THE_SPREAD') {
          pickType = 'spread';
        } else if (marketType === 'TOTAL' || marketType === 'OVER_UNDER') {
          pickType = 'over_under';
        }

        // Determine side
        let side: Side = 'home';
        if (pickType === 'over_under') {
          const label = (selection?.label || '').toLowerCase();
          side = label.includes('under') ? 'under' : 'over';
        } else if (selection?.side) {
          side = selection.side === 'HOME' ? 'home' : 'away';
        }

        // Expert name
        const expertName = expert
          ? `${expert.firstName || ''} ${expert.lastName || ''}`.trim()
          : 'SportsLine';

        // Confidence from unit rating (0.5-5 scale)
        const units = node.unit || selection?.unit || 0;
        const confidence = units >= 3 ? 'best_bet' as const
          : units >= 2 ? 'high' as const
          : units >= 1 ? 'medium' as const
          : 'low' as const;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType,
          side,
          value: selection?.odds ?? selection?.value ?? null,
          pickerName: expertName || 'SportsLine',
          confidence,
          reasoning: [
            selection?.label || '',
            selection?.subLabel || '',
            node.writeup ? node.writeup.slice(0, 200) : '',
          ].filter(Boolean).join(' | ').slice(0, 300) || null,
          fetchedAt,
        });
      }
    } catch { /* ignore parse errors */ }
    return predictions;
  }
}
