import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Dunkel Index adapter.
 *
 * Dunkel Index publishes computer-model picks via a JSON API.
 * We hit the API endpoint directly (e.g. /picks/get/3 for NBA)
 * and parse the JSON response.
 *
 * API shape:
 *   { games: DunkelGame[], success, selected_league, ... }
 */
export class DunkelIndexAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'dunkel-index',
    name: 'Dunkel Index',
    baseUrl: 'https://www.dunkelindex.com',
    fetchMethod: 'http',
    paths: {
      nba: '/picks/get/3',
      nfl: '/picks/get/1',
      mlb: '/picks/get/7',
      nhl: '/picks/get/8',
      ncaab: '/picks/get/6',
    },
    cron: '0 0 9,13,17,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const data = this.extractData(html);
    if (!data || data.length === 0) return [];

    const predictions: RawPrediction[] = [];

    for (const game of data) {
      if (game.status?.toLowerCase() !== 'scheduled') continue;

      const homeTeamRaw = game.home_team_full_name || game.home_team_name;
      const awayTeamRaw = game.away_team_full_name || game.away_team_name;
      const gameDate = this.extractDate(game.date_of_match);

      if (!homeTeamRaw || !awayTeamRaw || !gameDate) continue;

      const gameTime = this.extractTime(game.date_of_match);
      const confidence = this.mapRankDiff(game.home_team_rank, game.away_team_rank);
      const reasoning = this.buildReasoning(game);

      // Spread pick — dunkel_line is the Dunkel spread prediction
      if (game.dunkel_line != null) {
        const spreadVal = typeof game.dunkel_line === 'string'
          ? parseFloat(game.dunkel_line)
          : game.dunkel_line;
        if (!isNaN(spreadVal)) {
          // dunkel_pick is the team_id Dunkel picks; compare to home_team_id
          const side: Side = game.dunkel_pick === game.home_team_id ? 'home' : 'away';

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
            pickerName: 'Dunkel Index Model',
            confidence,
            reasoning,
            fetchedAt,
          });
        }
      }

      // Over/under from dunkel_total and dunkel_over_under
      if (game.dunkel_total != null && game.dunkel_over_under) {
        const totalVal = typeof game.dunkel_total === 'string'
          ? parseFloat(game.dunkel_total)
          : game.dunkel_total;
        const ouDirection = game.dunkel_over_under.toLowerCase();
        if (!isNaN(totalVal) && (ouDirection === 'over' || ouDirection === 'under')) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate,
            gameTime,
            pickType: 'over_under',
            side: ouDirection as Side,
            value: totalVal,
            pickerName: 'Dunkel Index Model',
            confidence,
            reasoning,
            fetchedAt,
          });
        }
      }

      // Moneyline from team_recommendation
      if (game.team_recommendation) {
        const side: Side = game.team_recommendation === game.home_team_id ? 'home' : 'away';
        const mlValue = game.money_line ? parseInt(String(game.money_line), 10) : null;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'moneyline',
          side,
          value: isNaN(mlValue as number) ? null : mlValue,
          pickerName: 'Dunkel Index Model',
          confidence,
          reasoning: game.pick_of_day_explanation
            ? `${reasoning || ''} | ${game.pick_of_day_explanation}`.replace(/^\s*\|\s*/, '')
            : reasoning,
          fetchedAt,
        });
      }
    }

    return predictions;
  }

  private extractData(html: string): DunkelGame[] | null {
    // First try: raw JSON response (API endpoint returns JSON directly)
    try {
      const parsed = JSON.parse(html) as DunkelResponse;
      if (parsed.games && Array.isArray(parsed.games)) return parsed.games;
      // Legacy fallback
      if ((parsed as any).data && Array.isArray((parsed as any).data)) return (parsed as any).data;
    } catch {
      // Not raw JSON — try extracting from HTML
    }

    // Second try: JSON embedded in a script tag
    const match = html.match(
      /(?:window\.__DATA__|window\.dunkelData)\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|$)/,
    );
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1]) as DunkelResponse;
        return parsed.games || null;
      } catch {
        return null;
      }
    }

    return null;
  }

  private extractDate(dateStr: string | null): string | null {
    if (!dateStr) return null;
    // "2026-02-24 19:00:00" → "2026-02-24"
    const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1]! : null;
  }

  private extractTime(dateStr: string | null): string | null {
    if (!dateStr) return null;
    // "2026-02-24 19:00:00" → "19:00"
    const match = dateStr.match(/(\d{2}:\d{2}):\d{2}$/);
    return match ? match[1]! : null;
  }

  private mapRankDiff(homeRank: number | null, awayRank: number | null): Confidence | null {
    if (homeRank == null || awayRank == null) return null;
    const diff = Math.abs(homeRank - awayRank);
    if (diff >= 15) return 'best_bet';
    if (diff >= 10) return 'high';
    if (diff >= 5) return 'medium';
    return 'low';
  }

  private buildReasoning(game: DunkelGame): string | null {
    const parts: string[] = [];
    if (game.home_team_dunkel_rating && game.away_team_dunkel_rating) {
      parts.push(`Ratings: ${game.away_team_key || 'Away'} ${game.away_team_dunkel_rating} vs ${game.home_team_key || 'Home'} ${game.home_team_dunkel_rating}`);
    }
    if (game.dunkel_pick_name) {
      parts.push(`Dunkel pick: ${game.dunkel_pick_name}`);
    }
    if (game.vegas_line) {
      parts.push(`Vegas line: ${game.vegas_line}`);
    }
    return parts.length > 0 ? parts.join(' | ') : null;
  }
}

// ---- Type definitions for Dunkel Index API ----

interface DunkelResponse {
  games: DunkelGame[];
  success?: boolean;
  selected_league?: string;
  selected_league_uri?: string;
  selected_sport?: string;
}

interface DunkelGame {
  id: string;
  date_of_match: string;
  date_of_match_utc: string;
  status: string;
  stadium_name: string;
  home_team_id: string;
  away_team_id: string;
  home_team_key: string;
  away_team_key: string;
  home_team_name: string;
  away_team_name: string;
  home_team_full_name: string;
  away_team_full_name: string;
  home_team_dunkel_rating: string | null;
  away_team_dunkel_rating: string | null;
  home_team_rank: number | null;
  away_team_rank: number | null;
  dunkel_pick: string;
  dunkel_pick_name: string;
  dunkel_line: number | string | null;
  dunkel_total: number | string | null;
  dunkel_over_under: string | null;
  vegas_pick: string;
  vegas_pick_name: string;
  vegas_line: string | null;
  over_under: string | null;
  money_line: string | number | null;
  money_line_label: string;
  team_recommendation: string;
  pick_of_day: string;
  pick_of_day_explanation: string;
  season_type: string;
  league: string;
  game_number: number;
  home_team_score: string;
  away_team_score: string;
}
