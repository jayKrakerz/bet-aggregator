import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Dunkel Index adapter.
 *
 * Dunkel Index publishes computer-model picks via a JSON API.
 * The fetch worker hits the page URL and we extract the embedded
 * JSON data (rendered into the page as a script payload).
 *
 * API shape:
 *   { data: DunkelGame[], league, league_id, date, total, page, pages }
 *
 * Each game has: dunkel_line (spread), dunkel_total, predicted scores,
 * moneyline odds, win percentages, and team rankings.
 */
export class DunkelIndexAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'dunkel-index',
    name: 'Dunkel Index',
    baseUrl: 'https://www.dunkelindex.com',
    fetchMethod: 'http',
    paths: {
      nba: '/picks/nba',
      nfl: '/picks/nfl',
      mlb: '/picks/mlb',
      nhl: '/picks/nhl',
      ncaab: '/picks/ncaab',
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
      if (game.status !== 'scheduled') continue;

      const homeTeamRaw = game.home_team;
      const awayTeamRaw = game.away_team;
      const gameDate = game.game_date;
      const gameTime = game.game_time || null;

      if (!homeTeamRaw || !awayTeamRaw || !gameDate) continue;

      const confidence = this.mapRankDiff(game.home_rank, game.away_rank);
      const reasoning = this.buildReasoning(game);

      // Spread pick — dunkel_line is from away perspective (negative = away favored)
      if (game.dunkel_line != null) {
        const spreadVal = game.dunkel_line;
        const side: Side = spreadVal < 0 ? 'away' : 'home';

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

      // Over/under from dunkel_total
      if (game.dunkel_total != null && game.dunkel_home_score != null && game.dunkel_away_score != null) {
        const predictedTotal = game.dunkel_home_score + game.dunkel_away_score;
        const side: Side = predictedTotal > game.dunkel_total ? 'over' : 'under';

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'over_under',
          side,
          value: game.dunkel_total,
          pickerName: 'Dunkel Index Model',
          confidence,
          reasoning,
          fetchedAt,
        });
      }

      // Moneyline from win percentages
      if (game.home_win_pct != null && game.away_win_pct != null) {
        const side: Side = game.home_win_pct > game.away_win_pct ? 'home' : 'away';
        const winPct = Math.max(game.home_win_pct, game.away_win_pct);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'moneyline',
          side,
          value: side === 'home' ? game.home_moneyline : game.away_moneyline,
          pickerName: 'Dunkel Index Model',
          confidence,
          reasoning: reasoning
            ? `${reasoning} | Win prob: ${winPct.toFixed(1)}%`
            : `Win prob: ${winPct.toFixed(1)}%`,
          fetchedAt,
        });
      }
    }

    return predictions;
  }

  private extractData(html: string): DunkelGame[] | null {
    // First try: raw JSON response (if fetched directly from API)
    try {
      const parsed = JSON.parse(html) as DunkelResponse;
      if (parsed.data && Array.isArray(parsed.data)) return parsed.data;
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
        return parsed.data || null;
      } catch {
        return null;
      }
    }

    return null;
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
    if (game.dunkel_home_score != null && game.dunkel_away_score != null) {
      parts.push(`Predicted: ${game.away_abbr || game.away_team} ${game.dunkel_away_score}, ${game.home_abbr || game.home_team} ${game.dunkel_home_score}`);
    }
    if (game.home_rating != null && game.away_rating != null) {
      parts.push(`Ratings: ${game.away_abbr || 'Away'} ${game.away_rating} vs ${game.home_abbr || 'Home'} ${game.home_rating}`);
    }
    return parts.length > 0 ? parts.join(' | ') : null;
  }
}

// ---- Type definitions for Dunkel Index API ----

interface DunkelResponse {
  data: DunkelGame[];
  league?: string;
  league_id?: number;
  date?: string;
  total?: number;
  page?: number;
  pages?: number;
}

interface DunkelGame {
  game_id: number;
  home_team: string;
  away_team: string;
  home_abbr?: string;
  away_abbr?: string;
  game_date: string;
  game_time?: string;
  home_rank: number | null;
  away_rank: number | null;
  home_rating: number | null;
  away_rating: number | null;
  dunkel_line: number | null;
  dunkel_total: number | null;
  dunkel_home_score: number | null;
  dunkel_away_score: number | null;
  home_moneyline: number | null;
  away_moneyline: number | null;
  home_win_pct: number | null;
  away_win_pct: number | null;
  status: string;
}
