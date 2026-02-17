import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * OddsTrader adapter.
 *
 * OddsTrader is a React SSR app that embeds event metadata in
 * `window.__INITIAL_STATE__` JSON but loads picks via JS hydration.
 * Requires browser rendering to populate the picks data.
 *
 * Data path:
 *   state.picks.events[lid]  → event metadata (teams, date, venue)
 *   state.picks.picks[lid].picks → predictions per event
 *
 * Each pick contains:
 *   - stats[]: homescore, roadscore, event-winner-spreadline, totalScore, rank
 *   - consensus[]: betting percentages by market type (83=ML, 401=spread, 402=total)
 *
 * League IDs: NBA=5, NFL=16, MLB=3, NHL=7, NCAAB=14, NCAAF=6
 */
export class OddsTraderAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'oddstrader',
    name: 'OddsTrader',
    baseUrl: 'https://www.oddstrader.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/nba/picks/',
      nfl: '/nfl/picks/',
      mlb: '/mlb/picks/',
      nhl: '/nhl/picks/',
    },
    cron: '0 0 9,13,17,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for React to hydrate and picks data to load into __INITIAL_STATE__
    await page.waitForFunction(
      () => {
        const w = globalThis as Record<string, unknown>;
        const state = w.__INITIAL_STATE__ as Record<string, unknown> | undefined;
        if (!state?.picks) return false;
        const picks = state.picks as Record<string, unknown>;
        const picksMap = picks.picks as Record<string, { picks?: unknown[] }> | undefined;
        if (!picksMap) return false;
        return Object.values(picksMap).some((c) => c.picks && c.picks.length > 0);
      },
      { timeout: 15000 },
    ).catch(() => {});
    // Extra buffer for any remaining async updates
    await page.waitForTimeout(2000);
  }

  private static readonly SPORT_TO_LID: Record<string, string[]> = {
    nba: ['5'],
    nfl: ['16'],
    mlb: ['3'],
    nhl: ['7'],
    ncaab: ['14'],
    ncaaf: ['6'],
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const state = this.extractState(html);
    if (!state) return [];

    const predictions: RawPrediction[] = [];
    const lids = OddsTraderAdapter.SPORT_TO_LID[sport] || [];

    // Also scan all available league IDs in case the page has cross-sport data
    const availableLids = new Set([
      ...lids,
      ...Object.keys(state.picks?.events || {}),
    ]);

    for (const lid of availableLids) {
      // Only process lids that match the requested sport
      if (lids.length > 0 && !lids.includes(lid)) continue;

      const events: OTEvent[] = state.picks?.events?.[lid] || [];
      const picksContainer = state.picks?.picks?.[lid];
      const picks: OTPick[] = picksContainer?.picks || [];

      if (events.length === 0) continue;

      const eventMap = new Map<string, OTEvent>();
      for (const ev of events) {
        eventMap.set(String(ev.eid), ev);
      }

      for (const pick of picks) {
        const event = eventMap.get(String(pick.eid));
        if (!event) continue;

        const homeParticipant = event.participants?.find((p) => p.ih);
        const awayParticipant = event.participants?.find((p) => !p.ih);
        if (!homeParticipant || !awayParticipant) continue;

        const homeTeamRaw = `${homeParticipant.source.nam} ${homeParticipant.source.nn}`.trim();
        const awayTeamRaw = `${awayParticipant.source.nam} ${awayParticipant.source.nn}`.trim();
        const gameDate = new Date(event.dt).toISOString().split('T')[0]!;
        const gameTime = this.formatTime(event.dt);

        const homeScore = this.getStat(pick, 'homescore');
        const roadScore = this.getStat(pick, 'roadscore');
        const spreadLine = this.getStatEntry(pick, 'event-winner-spreadline');
        const totalScore = this.getStat(pick, 'totalScore');
        const rank = this.getStat(pick, 'rank');
        const confidence = this.mapRank(rank);
        const reasoning = homeScore && roadScore
          ? `Predicted: ${roadScore}-${homeScore}`
          : null;

        // Spread pick
        if (spreadLine) {
          const spreadVal = parseFloat(spreadLine.val);
          if (!isNaN(spreadVal)) {
            // partid tells us which team the spread belongs to
            const spreadIsHome = spreadLine.partid === homeParticipant.partid;
            predictions.push({
              sourceId: this.config.id,
              sport,
              homeTeamRaw,
              awayTeamRaw,
              gameDate,
              gameTime,
              pickType: 'spread',
              side: spreadIsHome ? 'home' : 'away',
              value: spreadVal,
              pickerName: 'OddsTrader AI',
              confidence,
              reasoning,
              fetchedAt,
            });
          }
        }

        // Over/under from totalScore
        if (totalScore) {
          const total = parseFloat(totalScore);
          if (!isNaN(total)) {
            // Use consensus to determine over vs under
            const overConsensus = this.getConsensusPerc(pick, 402, 15143);
            const underConsensus = this.getConsensusPerc(pick, 402, 15144);
            const side: Side = overConsensus >= underConsensus ? 'over' : 'under';

            predictions.push({
              sourceId: this.config.id,
              sport,
              homeTeamRaw,
              awayTeamRaw,
              gameDate,
              gameTime,
              pickType: 'over_under',
              side,
              value: total,
              pickerName: 'OddsTrader AI',
              confidence,
              reasoning,
              fetchedAt,
            });
          }
        }

        // Moneyline from consensus (mtid=83)
        const mlConsensus = pick.consensus?.filter((c) => c.mtid === 83) || [];
        if (mlConsensus.length >= 2) {
          const best = mlConsensus.reduce((a, b) => (a.perc > b.perc ? a : b));
          if (best.perc > 50) {
            const isHome = best.partid === homeParticipant.partid;
            predictions.push({
              sourceId: this.config.id,
              sport,
              homeTeamRaw,
              awayTeamRaw,
              gameDate,
              gameTime,
              pickType: 'moneyline',
              side: isHome ? 'home' : 'away',
              value: null,
              pickerName: 'OddsTrader AI',
              confidence,
              reasoning: reasoning
                ? `${reasoning} | ML consensus: ${Math.round(best.perc)}%`
                : `ML consensus: ${Math.round(best.perc)}%`,
              fetchedAt,
            });
          }
        }
      }
    }

    return predictions;
  }

  private extractState(html: string): OTState | null {
    const match = html.match(
      /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|<\/script>)/,
    );
    if (!match?.[1]) return null;

    try {
      return JSON.parse(match[1]) as OTState;
    } catch {
      return null;
    }
  }

  private getStat(pick: OTPick, stat: string): string | null {
    return pick.stats?.find((s) => s.stat === stat)?.val ?? null;
  }

  private getStatEntry(pick: OTPick, stat: string): OTStat | undefined {
    return pick.stats?.find((s) => s.stat === stat);
  }

  private getConsensusPerc(pick: OTPick, mtid: number, partid: number): number {
    return pick.consensus?.find((c) => c.mtid === mtid && c.partid === partid)?.perc ?? 0;
  }

  private mapRank(rank: string | null): Confidence | null {
    if (!rank) return null;
    const num = parseInt(rank, 10);
    if (num >= 5) return 'best_bet';
    if (num >= 4) return 'high';
    if (num >= 3) return 'medium';
    return 'low';
  }

  private formatTime(dtMs: number): string | null {
    try {
      const d = new Date(dtMs);
      if (isNaN(d.getTime())) return null;
      const hours = d.getUTCHours();
      const minutes = d.getUTCMinutes();
      if (hours === 0 && minutes === 0) return null;
      const period = hours >= 12 ? 'PM' : 'AM';
      const h = hours % 12 || 12;
      const m = minutes.toString().padStart(2, '0');
      return `${h}:${m} ${period} ET`;
    } catch {
      return null;
    }
  }
}

// ---- Type definitions for __INITIAL_STATE__ ----

interface OTState {
  picks?: {
    events?: Record<string, OTEvent[]>;
    picks?: Record<string, { lid?: number; picks: OTPick[] }>;
  };
}

interface OTEvent {
  eid: number;
  des: string;
  lid: number;
  dt: number;
  es: string;
  participants: OTParticipant[];
}

interface OTParticipant {
  partid: number;
  ih: boolean;
  isFavorite: boolean;
  source: {
    nam: string;
    nn: string;
    sn: string;
    abbr: string;
  };
}

interface OTPick {
  eid: string | number;
  consensus: OTConsensus[];
  stats: OTStat[];
}

interface OTConsensus {
  eid: number;
  mtid: number;
  boid: number;
  partid: number;
  sbid: number;
  perc: number;
  wag: number;
}

interface OTStat {
  val: string;
  stat: string;
  paid: string | null;
  idty: string;
  partid: number | null;
}
