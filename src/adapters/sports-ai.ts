import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

const SPORT_ID_MAP: Record<number, string> = {
  1: 'football',
  2: 'tennis',
  3: 'nba',
  9: 'mlb',
};

const VALUE_BET_SPORT_MAP: Record<string, string> = {
  Soccer: 'football',
  Basketball: 'nba',
  Baseball: 'mlb',
  'Ice Hockey': 'nhl',
  'American Football': 'nfl',
  Tennis: 'tennis',
};

/**
 * Sports AI adapter (sports-ai.dev).
 *
 * Next.js SSR app with data embedded in `__NEXT_DATA__` script tags.
 * Two pages:
 *   /predictions  — AI probability predictions (moneyline, spread, totals)
 *   /value-bets   — Value bet picks with edge percentages
 */
export class SportsAiAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'sports-ai',
    name: 'Sports AI',
    baseUrl: 'https://www.sports-ai.dev',
    fetchMethod: 'http',
    paths: {
      predictions: '/predictions',
      'value-bets': '/value-bets',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const nextData = this.extractNextData(html);
    if (!nextData) return [];

    if (sport === 'predictions') {
      return this.parsePredictions(nextData, fetchedAt);
    }
    if (sport === 'value-bets') {
      return this.parseValueBets(nextData, fetchedAt);
    }
    return [];
  }

  private extractNextData(html: string): any | null {
    const match = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/);
    if (!match?.[1]) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Predictions page
  // ---------------------------------------------------------------------------

  private parsePredictions(nextData: any, fetchedAt: Date): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    // Navigate into pageProps — exact key path may vary, search common locations
    const entries = this.findArray(nextData, ['props', 'pageProps', 'predictions'])
      ?? this.findArray(nextData, ['props', 'pageProps', 'data'])
      ?? this.findArray(nextData, ['props', 'pageProps', 'matches'])
      ?? [];

    for (const entry of entries) {
      const sportId = entry.sport_id ?? entry.sportId;
      const sport = SPORT_ID_MAP[sportId];
      if (!sport) continue;

      const home = (entry.home ?? entry.homeTeam ?? '').trim();
      const away = (entry.away ?? entry.awayTeam ?? '').trim();
      if (!home || !away) continue;

      const gameDate = this.toISODate(entry.date ?? entry.startTime, fetchedAt);

      // Moneyline from odds_moneyline
      const mlOdds = entry.odds_moneyline ?? entry.oddsMoneyline;
      if (mlOdds) {
        const pick = this.pickMoneyline(mlOdds, sport);
        if (pick) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: home,
            awayTeamRaw: away,
            gameDate,
            gameTime: null,
            pickType: 'moneyline',
            side: pick.side,
            value: null,
            pickerName: 'Sports AI',
            confidence: pick.confidence,
            reasoning: pick.reasoning,
            fetchedAt,
          });
        }
      }

      // Spread from first odds_handicap entry
      const hdpArr = entry.odds_handicap ?? entry.oddsHandicap;
      if (Array.isArray(hdpArr) && hdpArr.length > 0) {
        const hdp = hdpArr[0];
        const line = parseFloat(hdp.hdp ?? hdp.handicap ?? hdp.line);
        if (!isNaN(line)) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: home,
            awayTeamRaw: away,
            gameDate,
            gameTime: null,
            pickType: 'spread',
            side: line < 0 ? 'home' : 'away',
            value: line,
            pickerName: 'Sports AI',
            confidence: null,
            reasoning: `Handicap line ${line > 0 ? '+' : ''}${line}`,
            fetchedAt,
          });
        }
      }

      // Over/under from first odds_totals entry
      const totArr = entry.odds_totals ?? entry.oddsTotals;
      if (Array.isArray(totArr) && totArr.length > 0) {
        const tot = totArr[0];
        const points = parseFloat(tot.points ?? tot.total ?? tot.line);
        const overOdds = parseFloat(tot.over ?? tot.overOdds ?? 0);
        const underOdds = parseFloat(tot.under ?? tot.underOdds ?? 0);
        if (!isNaN(points)) {
          const side: Side = overOdds < underOdds ? 'over' : 'under';
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: home,
            awayTeamRaw: away,
            gameDate,
            gameTime: null,
            pickType: 'over_under',
            side,
            value: points,
            pickerName: 'Sports AI',
            confidence: null,
            reasoning: `O/U ${points} (over ${overOdds}, under ${underOdds})`,
            fetchedAt,
          });
        }
      }
    }

    return predictions;
  }

  private pickMoneyline(
    mlOdds: Record<string, number>,
    sport: string,
  ): { side: Side; confidence: Confidence; reasoning: string } | null {
    // mlOdds typically: { home: 1.8, draw: 3.5, away: 4.2 } or { "1": 1.8, "X": 3.5, "2": 4.2 }
    const homeOdds = mlOdds.home ?? mlOdds['1'] ?? mlOdds.h;
    const awayOdds = mlOdds.away ?? mlOdds['2'] ?? mlOdds.a;
    const drawOdds = mlOdds.draw ?? mlOdds['X'] ?? mlOdds.x ?? mlOdds.d;

    if (homeOdds == null && awayOdds == null) return null;

    // Implied probabilities: 1/odds
    const homeProb = homeOdds ? 1 / homeOdds : 0;
    const awayProb = awayOdds ? 1 / awayOdds : 0;
    const drawProb = drawOdds ? 1 / drawOdds : 0;

    let side: Side;
    let bestProb: number;

    if (sport === 'football' && drawProb > homeProb && drawProb > awayProb) {
      side = 'draw';
      bestProb = drawProb;
    } else if (homeProb >= awayProb) {
      side = 'home';
      bestProb = homeProb;
    } else {
      side = 'away';
      bestProb = awayProb;
    }

    const pct = Math.round(bestProb * 100);
    const confidence: Confidence =
      pct >= 70 ? 'best_bet' :
      pct >= 55 ? 'high' :
      pct >= 40 ? 'medium' :
      'low';

    return {
      side,
      confidence,
      reasoning: `Implied prob ${pct}% (home ${Math.round(homeProb * 100)}%${drawProb ? ` draw ${Math.round(drawProb * 100)}%` : ''} away ${Math.round(awayProb * 100)}%)`,
    };
  }

  // ---------------------------------------------------------------------------
  // Value bets page
  // ---------------------------------------------------------------------------

  private parseValueBets(nextData: any, fetchedAt: Date): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    const entries = this.findArray(nextData, ['props', 'pageProps', 'valueBets'])
      ?? this.findArray(nextData, ['props', 'pageProps', 'data'])
      ?? this.findArray(nextData, ['props', 'pageProps', 'bets'])
      ?? [];

    for (const entry of entries) {
      const sportGroup = entry.sport?.group ?? entry.sportGroup ?? '';
      const sport = VALUE_BET_SPORT_MAP[sportGroup];
      if (!sport) continue;

      // "Team A - Team B"
      const matchStr: string = entry.match ?? entry.matchName ?? '';
      const parts = matchStr.split(' - ');
      if (parts.length < 2) continue;
      const home = parts[0]!.trim();
      const away = parts.slice(1).join(' - ').trim();
      if (!home || !away) continue;

      const outcome: string = (entry.outcome ?? '').trim();
      if (!outcome) continue;

      const side = this.resolveOutcomeSide(outcome, home, away);

      // Best edge from bookmakers
      const bookmakers: any[] = entry.bookmakers ?? [];
      let bestEdge = 0;
      let bestBookmaker = '';
      let bestPrice = 0;
      for (const bk of bookmakers) {
        const edge = parseFloat(bk.percentageDifference ?? bk.edge ?? 0);
        if (edge > bestEdge) {
          bestEdge = edge;
          bestBookmaker = bk.name ?? bk.bookmaker ?? '';
          bestPrice = parseFloat(bk.price ?? bk.odds ?? 0);
        }
      }

      const trueOdds = parseFloat(entry.trueOdds ?? 0);
      const value = bestPrice || trueOdds || null;

      const confidence: Confidence =
        bestEdge >= 15 ? 'best_bet' :
        bestEdge >= 10 ? 'high' :
        bestEdge >= 5 ? 'medium' :
        'low';

      const league = entry.league ?? entry.sport?.name ?? '';
      const reasoning = [
        bestEdge ? `Edge ${bestEdge.toFixed(1)}%` : '',
        bestBookmaker ? `at ${bestBookmaker}` : '',
        league ? `(${league})` : '',
        trueOdds ? `True odds ${trueOdds.toFixed(2)}` : '',
      ].filter(Boolean).join(' ') || null;

      const gameDate = this.toISODate(entry.date ?? entry.startTime ?? entry.commence_time, fetchedAt);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: home,
        awayTeamRaw: away,
        gameDate,
        gameTime: null,
        pickType: 'moneyline',
        side,
        value,
        pickerName: 'Sports AI Value',
        confidence,
        reasoning,
        fetchedAt,
      });
    }

    return predictions;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resolveOutcomeSide(outcome: string, home: string, away: string): Side {
    const oLower = outcome.toLowerCase();
    const hLower = home.toLowerCase();
    const aLower = away.toLowerCase();
    if (oLower.includes('draw')) return 'draw';
    if (oLower === hLower || hLower.includes(oLower) || oLower.includes(hLower)) return 'home';
    if (oLower === aLower || aLower.includes(oLower) || oLower.includes(aLower)) return 'away';
    // Fallback: partial match on first/last word
    const oWords = oLower.split(/\s+/);
    const hWords = hLower.split(/\s+/);
    const aWords = aLower.split(/\s+/);
    if (oWords.some(w => w.length > 2 && hWords.includes(w))) return 'home';
    if (oWords.some(w => w.length > 2 && aWords.includes(w))) return 'away';
    return 'home';
  }

  private findArray(obj: any, path: string[]): any[] | null {
    let current = obj;
    for (const key of path) {
      if (current == null || typeof current !== 'object') return null;
      current = current[key];
    }
    return Array.isArray(current) ? current : null;
  }

  private toISODate(value: any, fallback: Date): string {
    if (value == null) return fallback.toISOString().split('T')[0]!;
    // Unix timestamp (seconds)
    if (typeof value === 'number' && value > 1e9 && value < 1e11) {
      return new Date(value * 1000).toISOString().split('T')[0]!;
    }
    // Unix timestamp (milliseconds)
    if (typeof value === 'number' && value >= 1e11) {
      return new Date(value).toISOString().split('T')[0]!;
    }
    // ISO string or date string
    if (typeof value === 'string') {
      const d = new Date(value);
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0]!;
    }
    return fallback.toISOString().split('T')[0]!;
  }
}
