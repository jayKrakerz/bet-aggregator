import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side } from '../types/prediction.js';

/**
 * Pickswise adapter.
 *
 * Pickswise is a Next.js app. Pick data is loaded via client-side JS after
 * hydration, so `__NEXT_DATA__` in the initial HTML is usually empty.
 * Requires browser rendering, then attempts __NEXT_DATA__ first and
 * falls back to DOM extraction from rendered pick cards.
 *
 * Data path (when populated):
 *   props.pageProps.initialState.sportPredictionsPicks[pagePath] → Prediction[]
 */
export class PickswiseAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'pickswise',
    name: 'Pickswise',
    baseUrl: 'https://www.pickswise.com',
    fetchMethod: 'browser',
    paths: { nba: '/nba/picks/' },
    cron: '0 */30 9-23 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for pick cards to render after React hydration
    await page.waitForSelector('[class*="PickCard"], [class*="pickCard"], [class*="GameCard"], [class*="gameCard"], [class*="card"]', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
    // Scroll to trigger lazy loading
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);

    // Try __NEXT_DATA__ JSON first (may be populated after browser rendering)
    const nextDataScript = $('#__NEXT_DATA__').html();
    if (nextDataScript) {
      try {
        const nextData = JSON.parse(nextDataScript) as NextData;
        const results = this.extractFromNextData(nextData, sport, fetchedAt);
        if (results.length > 0) return results;
      } catch {
        // Fall through to DOM parsing
      }
    }

    // Fallback: extract picks from rendered DOM
    return this.extractFromDom($, sport, fetchedAt);
  }

  /**
   * Extract predictions from the rendered DOM when __NEXT_DATA__ is empty.
   * Pickswise uses hashed CSS module class names, so we match partial patterns.
   */
  private extractFromDom(
    $: ReturnType<typeof this.load>,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    // Look for elements that contain pick data by searching for common patterns
    // Pickswise cards typically have team names, outcome text, and odds
    $('[class*="PickCard"], [class*="pickCard"], [class*="GameCard"], [class*="gameCard"]').each((_i, el) => {
      const $card = $(el);
      const text = $card.text();

      // Look for team names in heading-like elements
      const teams = $card.find('h2, h3, [class*="team"], [class*="Team"]');
      if (teams.length < 2) return;

      const homeTeamRaw = $(teams[0]).text().trim();
      const awayTeamRaw = $(teams[1]).text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Extract outcome text
      const outcome = $card.find('[class*="outcome"], [class*="Outcome"], [class*="pick"], [class*="Pick"]').first().text().trim();
      if (!outcome) return;

      const pickType = this.inferPickType(outcome);
      const side = this.resolveSideFromText(outcome, homeTeamRaw, awayTeamRaw);
      const value = this.resolveValueFromText(outcome, pickType);

      // Extract odds
      const oddsText = $card.find('[class*="odds"], [class*="Odds"]').first().text().trim();
      const oddsNum = oddsText ? parseFloat(oddsText.replace(/[^0-9.+-]/g, '')) : null;

      // Extract tipster
      const tipster = $card.find('[class*="tipster"], [class*="Tipster"], [class*="expert"], [class*="Expert"]').first().text().trim();

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate: fetchedAt.toISOString().split('T')[0]!,
        gameTime: null,
        pickType,
        side,
        value: value ?? (oddsNum && !isNaN(oddsNum) ? oddsNum : null),
        pickerName: tipster || 'Pickswise Expert',
        confidence: null,
        reasoning: null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private resolveSideFromText(outcome: string, home: string, away: string): Side {
    const lower = outcome.toLowerCase();
    if (lower.startsWith('over')) return 'over';
    if (lower.startsWith('under')) return 'under';
    if (home && lower.includes(home.toLowerCase().split(' ')[0] || '')) return 'home';
    if (away && lower.includes(away.toLowerCase().split(' ')[0] || '')) return 'away';
    return 'home';
  }

  private resolveValueFromText(outcome: string, pickType: PickType): number | null {
    const match = outcome.match(/[+-]?\d+\.?\d*/);
    if (!match) return null;
    const val = parseFloat(match[0]);
    if (isNaN(val)) return null;
    if (pickType === 'spread' || pickType === 'over_under') return val;
    return null;
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
