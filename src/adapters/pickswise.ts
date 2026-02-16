import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side } from '../types/prediction.js';

/**
 * Pickswise adapter.
 *
 * Pickswise is a Next.js app. All pick data lives in `__NEXT_DATA__` JSON
 * embedded in the HTML, making DOM parsing unnecessary.
 *
 * Data path:
 *   props.pageProps.initialState.sportPredictionsPicks[pagePath] → Prediction[]
 *
 * Each Prediction contains:
 *   - homeTeam / awayTeam (with nickname, name, abbreviation)
 *   - startTimeString (ISO date)
 *   - basePicks[] — individual picks, each with:
 *     - outcome: "Syracuse +19.5" or "Iowa State Win" or "Over 215.5"
 *     - line: numeric line value (null for moneyline)
 *     - oddsAmerican: "-115"
 *     - market: "Point Spread" | "Money Line" | "Total" | etc.
 *     - betTypes[].slug: "point-spread" | "money-line" | "over-under" | "prop-bets"
 *     - confidence: 1-5 (5 = Best Bet)
 *     - tipsters[]: expert info
 *     - reasoning: HTML analysis text
 */
export class PickswiseAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'pickswise',
    name: 'Pickswise',
    baseUrl: 'https://www.pickswise.com',
    fetchMethod: 'http',
    paths: { nba: '/nba/picks/' },
    cron: '0 */30 9-23 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);

    // Extract __NEXT_DATA__ JSON
    const nextDataScript = $('#__NEXT_DATA__').html();
    if (!nextDataScript) return [];

    try {
      const nextData = JSON.parse(nextDataScript) as NextData;
      return this.extractFromNextData(nextData, sport, fetchedAt);
    } catch {
      return [];
    }
  }

  private extractFromNextData(
    data: NextData,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];
    const picksMap = data.props?.pageProps?.initialState?.sportPredictionsPicks;
    if (!picksMap || typeof picksMap !== 'object') return [];

    // Find the first non-empty picks array (key is page path like "/nba/picks/")
    let picksArray: PredictionEntry[] = [];
    for (const key of Object.keys(picksMap)) {
      const arr = picksMap[key];
      if (Array.isArray(arr) && arr.length > 0) {
        picksArray = arr as PredictionEntry[];
        break;
      }
    }

    for (const prediction of picksArray) {
      const homeTeamRaw = prediction.homeTeam?.nickname || prediction.homeTeam?.name || '';
      const awayTeamRaw = prediction.awayTeam?.nickname || prediction.awayTeam?.name || '';
      const gameDate = prediction.startTimeString?.split('T')[0] || '';
      const gameTime = this.formatTime(prediction.startTimeString);

      // Each prediction has basePicks[] at the top level
      const basePicks = prediction.basePicks || [];

      for (const pick of basePicks) {
        const pickType = this.mapPickType(pick);
        const side = this.resolveSide(pick, prediction);
        const value = this.resolveValue(pick, pickType);
        const pickerName = pick.tipsters?.[0]?.name || 'Pickswise Expert';
        const confidence = this.mapConfidence(pick.confidence);
        const reasoning = this.stripHtml(pick.reasoning);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType,
          side,
          value,
          pickerName,
          confidence,
          reasoning,
          fetchedAt,
        });
      }
    }

    return predictions;
  }

  /**
   * Map Pickswise betTypes slug to our PickType.
   */
  private mapPickType(pick: BasePick): PickType {
    const slug = pick.betTypes?.[0]?.slug || '';
    switch (slug) {
      case 'point-spread': return 'spread';
      case 'money-line': return 'moneyline';
      case 'over-under': return 'over_under';
      case 'prop-bets': return 'prop';
      default:
        // Fall back to market text
        if (pick.market) {
          const m = pick.market.toLowerCase();
          if (m.includes('spread')) return 'spread';
          if (m.includes('money')) return 'moneyline';
          if (m.includes('total') || m.includes('over')) return 'over_under';
          if (m.includes('prop')) return 'prop';
        }
        return 'moneyline';
    }
  }

  /**
   * Determine which side the pick is on from the outcome text.
   * - Spread: "Syracuse +19.5" → check if team is home or away
   * - Moneyline: "Iowa State Win" → check if team is home or away
   * - Total: "Over 215.5" / "Under 215.5"
   */
  private resolveSide(pick: BasePick, prediction: PredictionEntry): Side {
    const outcome = (pick.outcome || '').toLowerCase();

    // Over/under
    if (outcome.startsWith('over')) return 'over';
    if (outcome.startsWith('under')) return 'under';

    // Team-based: compare outcome text to home/away team names
    const homeNick = (prediction.homeTeam?.nickname || '').toLowerCase();
    const awayNick = (prediction.awayTeam?.nickname || '').toLowerCase();

    if (homeNick && outcome.startsWith(homeNick)) return 'home';
    if (awayNick && outcome.startsWith(awayNick)) return 'away';

    // Fallback: check full name
    const homeName = (prediction.homeTeam?.name || '').toLowerCase();
    const awayName = (prediction.awayTeam?.name || '').toLowerCase();
    if (homeName && outcome.includes(homeName.split(' ')[0] || '')) return 'home';
    if (awayName && outcome.includes(awayName.split(' ')[0] || '')) return 'away';

    return 'home';
  }

  /**
   * Extract the numeric value for the pick.
   * - Spread: use `line` field (the numeric spread value)
   * - Moneyline: use `oddsAmerican` parsed to number
   * - Total: parse from `outcome` ("Over 215.5" → 215.5)
   */
  private resolveValue(pick: BasePick, pickType: PickType): number | null {
    if (pickType === 'spread') {
      // line is always positive; use lineText for the sign
      if (pick.lineText) {
        const num = parseFloat(pick.lineText);
        if (!isNaN(num)) return num;
      }
      return pick.line ?? null;
    }

    if (pickType === 'over_under') {
      // Parse total from outcome text or line
      if (pick.line != null) return pick.line;
      const match = pick.outcome?.match(/[\d.]+/);
      return match ? parseFloat(match[0]) : null;
    }

    if (pickType === 'moneyline') {
      // Return American odds as the value
      if (pick.oddsAmerican) {
        const num = parseFloat(pick.oddsAmerican);
        if (!isNaN(num)) return num;
      }
      return null;
    }

    // Props: return odds
    if (pick.oddsAmerican) {
      const num = parseFloat(pick.oddsAmerican);
      if (!isNaN(num)) return num;
    }
    return null;
  }

  /**
   * Map Pickswise confidence (1-5) to our confidence levels.
   */
  private mapConfidence(confidence: number | undefined): RawPrediction['confidence'] {
    if (!confidence) return null;
    if (confidence >= 5) return 'best_bet';
    if (confidence >= 4) return 'high';
    if (confidence >= 3) return 'medium';
    return 'low';
  }

  /**
   * Extract time from ISO date string.
   */
  private formatTime(isoString: string | undefined): string | null {
    if (!isoString) return null;
    try {
      const date = new Date(isoString);
      if (isNaN(date.getTime())) return null;
      const hours = date.getUTCHours();
      const minutes = date.getUTCMinutes();
      if (hours === 0 && minutes === 0) return null; // midnight = no time data
      const period = hours >= 12 ? 'PM' : 'AM';
      const h = hours % 12 || 12;
      const m = minutes.toString().padStart(2, '0');
      return `${h}:${m} ${period} ET`;
    } catch {
      return null;
    }
  }

  /**
   * Strip HTML tags from reasoning text.
   */
  private stripHtml(html: string | undefined): string | null {
    if (!html) return null;
    const text = html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 500) || null;
  }
}

// ---- Type definitions for __NEXT_DATA__ structure ----

interface NextData {
  props?: {
    pageProps?: {
      initialState?: {
        sportPredictionsPicks?: Record<string, unknown[]>;
      };
    };
  };
}

interface PredictionEntry {
  id?: number;
  homeTeam?: { nickname?: string; name?: string; abbreviation?: string };
  awayTeam?: { nickname?: string; name?: string; abbreviation?: string };
  startTimeString?: string;
  startTime?: number;
  basePicks?: BasePick[];
  groupedByTipster?: Array<{
    tipster?: { name?: string; slug?: string; guest?: boolean };
    basePicks?: BasePick[];
    hasBestBet?: boolean;
  }>;
}

interface BasePick {
  id?: number;
  outcome?: string;
  line?: number | null;
  lineText?: string | null;
  oddsAmerican?: string;
  oddsDecimal?: number;
  market?: string;
  confidence?: number;
  guestPick?: boolean;
  betTypes?: Array<{ slug?: string; name?: string }>;
  tipsters?: Array<{ name?: string; slug?: string; guest?: boolean }>;
  reasoning?: string;
  stake?: number;
}
