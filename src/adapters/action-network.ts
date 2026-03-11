import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side, Confidence } from '../types/prediction.js';

/**
 * Action Network adapter.
 *
 * Next.js SSR app that embeds a `window.TAN_APP_DATA` JSON blob in the HTML.
 * Contains expert picks with full structured data (teams, odds, units, records).
 *
 * Data path:
 *   <script> containing window.TAN_APP_DATA → initialExpertsResponse → experts[] → picks[]
 */
export class ActionNetworkAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'action-network',
    name: 'Action Network',
    baseUrl: 'https://www.actionnetwork.com',
    fetchMethod: 'http',
    paths: {
      nba: '/nba/picks',
      nfl: '/nfl/picks',
      mlb: '/mlb/picks',
      nhl: '/nhl/picks',
      ncaab: '/ncaab/picks',
    },
    cron: '0 0 9,13,17,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const appData = this.extractAppData(html);
    if (!appData) return [];

    const predictions: RawPrediction[] = [];
    const experts = this.resolveExperts(appData);

    for (const expert of experts) {
      const picks = expert.picks || [];
      for (const pick of picks) {
        if (!pick.game?.teams?.length) continue;
        if (pick.result !== 'pending') continue;

        const teams = pick.game.teams;
        const awayTeam = teams.find((t: Team) => t.id === pick.game.away_team_id);
        const homeTeam = teams.find((t: Team) => t.id === pick.game.home_team_id);
        if (!awayTeam || !homeTeam) continue;

        const pickType = this.mapPickType(pick.type, pick.play);
        const side = this.resolveSide(pick, homeTeam, awayTeam);
        const value = this.resolveValue(pick, pickType);
        const gameDate = pick.game.start_time
          ? new Date(pick.game.start_time).toISOString().split('T')[0]!
          : fetchedAt.toISOString().split('T')[0]!;
        const gameTime = this.formatTime(pick.game.start_time);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam.full_name || homeTeam.abbr,
          awayTeamRaw: awayTeam.full_name || awayTeam.abbr,
          gameDate,
          gameTime,
          pickType,
          side,
          value,
          pickerName: expert.name || expert.username || 'Action Network Expert',
          confidence: this.unitsToConfidence(pick.units),
          reasoning: pick.play || null,
          fetchedAt,
        });
      }
    }

    return predictions;
  }

  private extractAppData(html: string): AppData | null {
    // Try __NEXT_DATA__ first — this contains the actual pick data
    const $ = this.load(html);
    const nextScript = $('#__NEXT_DATA__').html();
    if (nextScript) {
      try { return JSON.parse(nextScript); } catch { /* fall through */ }
    }

    // TAN_APP_DATA only has config/env, but try it as fallback
    const tanMatch = html.match(/window\.TAN_APP_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
    if (tanMatch?.[1]) {
      try { return JSON.parse(tanMatch[1]); } catch { /* fall through */ }
    }

    return null;
  }

  private resolveExperts(data: AppData): Expert[] {
    // Nested in props.pageProps — actual key is .response.profiles (not .experts)
    const pageProps = data.props?.pageProps;
    if (pageProps?.initialExpertsResponse?.response?.profiles) {
      return pageProps.initialExpertsResponse.response.profiles;
    }

    // Direct initialExpertsResponse
    if (data.initialExpertsResponse?.response?.profiles) {
      return data.initialExpertsResponse.response.profiles;
    }

    // Search for any profiles array in top-level keys
    for (const key of Object.keys(data)) {
      const val = data[key] as Record<string, unknown> | undefined;
      if (val && typeof val === 'object') {
        const resp = val as { response?: { profiles?: Expert[] } };
        if (resp.response?.profiles && Array.isArray(resp.response.profiles)) {
          return resp.response.profiles;
        }
      }
    }

    return [];
  }

  private mapPickType(type: string | undefined, play: string | undefined): PickType {
    const t = (type || '').toLowerCase();

    // Explicit compound types: ml_away, ml_home, spread_away, spread_home,
    // home_over, home_under, away_under, over, under, custom
    if (t.startsWith('ml_') || t === 'ml') return 'moneyline';
    if (t.startsWith('spread')) return 'spread';
    if (t === 'over' || t === 'under' || t.endsWith('_over') || t.endsWith('_under')) return 'over_under';
    if (t.includes('total')) return 'over_under';
    if (t.includes('moneyline')) return 'moneyline';
    if (t.includes('prop') || t.includes('player') || t.includes('custom')) return 'prop';
    if (t.includes('parlay')) return 'parlay';

    // Infer from play text
    const p = (play || '').toLowerCase();
    if (p.includes('spread') || /[+-]\d+\.?\d*$/.test(p)) return 'spread';
    if (p.includes('over') || p.includes('under') || p.includes('o/u')) return 'over_under';
    if (p.includes('ml') || p.includes('moneyline')) return 'moneyline';
    if (p.includes('pts') || p.includes('reb') || p.includes('ast')) return 'prop';

    return 'moneyline';
  }

  private resolveSide(pick: Pick, home: Team, away: Team): Side {
    const type = (pick.type || '').toLowerCase();
    const play = (pick.play || '').toLowerCase();

    // Compound types: over, under, home_over, home_under, away_under, ml_away, ml_home, spread_away, spread_home
    // For over/under types (including home_over, away_under etc), the side is over/under
    if (type === 'over' || type.endsWith('_over') || play.startsWith('over')) return 'over';
    if (type === 'under' || type.endsWith('_under') || play.startsWith('under')) return 'under';

    // For ml_home/spread_home, side is home; ml_away/spread_away, side is away
    if (type.endsWith('_home')) return 'home';
    if (type.endsWith('_away')) return 'away';

    // Legacy checks
    if (type.includes('home') || play.includes(home.abbr?.toLowerCase() || '---')) return 'home';
    if (type.includes('away') || play.includes(away.abbr?.toLowerCase() || '---')) return 'away';

    // Check full name
    const homeName = (home.full_name || '').toLowerCase();
    const awayName = (away.full_name || '').toLowerCase();
    if (homeName && play.includes(homeName.split(' ').pop() || '')) return 'home';
    if (awayName && play.includes(awayName.split(' ').pop() || '')) return 'away';

    return 'home';
  }

  private resolveValue(pick: Pick, pickType: PickType): number | null {
    if (pickType === 'prop' && pick.odds) return pick.odds;
    if (pick.odds && pickType === 'moneyline') return pick.odds;

    // Extract numeric value from play text
    const match = (pick.play || '').match(/([+-]?\d+\.?\d*)/);
    if (match) return parseFloat(match[1]!);

    return pick.odds ?? null;
  }

  private unitsToConfidence(units: number | undefined): Confidence | null {
    if (units == null) return null;
    if (units >= 3) return 'best_bet';
    if (units >= 2) return 'high';
    if (units >= 1) return 'medium';
    return 'low';
  }

  private formatTime(isoString: string | undefined): string | null {
    if (!isoString) return null;
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return null;
      const h = d.getUTCHours();
      const m = d.getUTCMinutes();
      if (h === 0 && m === 0) return null;
      const period = h >= 12 ? 'PM' : 'AM';
      return `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${period} ET`;
    } catch { return null; }
  }
}

// ---- Type definitions ----

interface Team {
  id: number;
  abbr: string;
  full_name?: string;
  logo?: string;
}

interface Pick {
  id?: number;
  league_name?: string;
  play?: string;
  type?: string;
  odds?: number;
  units?: number;
  units_net?: number;
  result?: string;
  starts_at?: string;
  game: {
    id: number;
    away_team_id: number;
    home_team_id: number;
    start_time?: string;
    teams: Team[];
  };
}

interface Expert {
  id?: number;
  name?: string;
  username?: string;
  is_expert?: boolean;
  record?: { win: number; loss: number; push: number; units_net: number };
  picks?: Pick[];
}

interface ExpertsResponse {
  response: { profiles: Expert[] };
}

interface AppData {
  [key: string]: unknown;
  initialExpertsResponse?: ExpertsResponse;
  props?: { pageProps?: { initialExpertsResponse?: ExpertsResponse } };
}
