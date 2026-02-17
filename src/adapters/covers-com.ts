import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side } from '../types/prediction.js';

/**
 * Covers.com adapter.
 *
 * Covers uses a two-level structure:
 * 1. Landing page (/nba/picks) → lists article links
 * 2. Each article page → has odds tables + "My best bet" callouts
 *
 * The landing page is fetched first; discoverUrls() extracts article links;
 * the fetch worker then fetches each article and feeds it to parse().
 */
export class CoversComAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'covers-com',
    name: 'Covers.com',
    baseUrl: 'https://www.covers.com',
    fetchMethod: 'http',
    paths: { nba: '/nba/picks' },
    cron: '0 */30 9-23 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  /**
   * Extract article URLs from the landing page.
   * Articles are in `article.single-article-LH` elements.
   */
  discoverUrls(html: string, _sport: string): string[] {
    const $ = this.load(html);
    const urls: string[] = [];

    $('article.single-article-LH').each((_i, el) => {
      const href = $(el).find('a[href]').attr('href');
      if (href && /pick|prediction|odds|best-bet/i.test(href)) {
        // Normalize to absolute URL
        const url = href.startsWith('http')
          ? href
          : `${this.config.baseUrl}${href}`;
        urls.push(url);
      }
    });

    return urls;
  }

  /**
   * Parse an individual article page for picks.
   *
   * Covers articles contain:
   * - Odds tables: `table.Covers-CoversArticles-AdminArticleTable`
   *   - Headers: [TeamA, "", TeamB] → 3-col matchup table
   *   - Rows: [odds/spread, "Moneyline"/"Spread"/"Total", odds/spread]
   * - Best bets: `<strong>Best bet:</strong>` or `<strong>My best bet</strong>` followed by pick text
   *   - Pattern: "TeamOrSide to win (odds at sportsbook)"
   * - Author: `[class*="authorName"]`
   */
  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    const author =
      $('[class*="authorName"]').first().text().trim().split('\n')[0]?.trim() ||
      'Covers Expert';

    // Extract best bet callouts from article body
    // Handles both <strong>Best bet:</strong> and <strong>My best bet</strong> formats
    $('strong, b').each((_i, el) => {
      const strongText = $(el).text().trim().toLowerCase();
      if (!strongText.includes('best bet')) return;

      // The pick text is in the same parent <p>
      const parent = $(el).parent();
      const fullText = parent.text().trim();

      // Remove the "Best bet:" / "My best bet" prefix
      const pickText = fullText
        .replace(/my best bet:?\s*/i, '')
        .replace(/best bet:?\s*/i, '')
        .trim();

      if (!pickText) return;

      // Also extract linked odds text (e.g. "+320 at bet365")
      const linkedOdds = parent.find('a').text().trim();

      // Parse the pick — handles both inline and linked odds
      const parsed = this.parseBestBetText(pickText, linkedOdds);
      if (!parsed) return;

      // Try to find the matchup from nearby tables
      const matchup = this.findNearestMatchup($, el);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup?.home || parsed.team || '',
        awayTeamRaw: matchup?.away || '',
        gameDate: this.extractDateFromPage($),
        gameTime: null,
        pickType: parsed.pickType,
        side: parsed.side,
        value: parsed.value,
        pickerName: author,
        confidence: 'best_bet',
        reasoning: pickText.slice(0, 200),
        fetchedAt,
      });
    });

    return predictions;
  }

  /**
   * Parse best bet text in several formats:
   * - "World (+165 at bet365)" — inline odds
   * - "Keshad Johnson to win (+320 at bet365)" — "to win" format with linked odds
   * - "Under 81.5 (-110 at bet365)"
   * - "Stripes -2.5 (-105 at bet365)"
   * - "Luka Doncic 2+ threes (+145 at bet365)"
   */
  private parseBestBetText(text: string, linkedOdds?: string): {
    team: string;
    pickType: PickType;
    side: Side;
    value: number | null;
  } | null {
    // Try to match "Something (odds at book)"
    let match = text.match(
      /^(.+?)\s*\(([+-]?\d+\.?\d*)\s*(?:at\s+.+?)?\)/,
    );

    // If no inline odds, try extracting odds from the linked text
    let pickPart: string;
    let oddsStr: string;

    if (match) {
      pickPart = match[1]!.trim().replace(/\s+to\s+win\s*$/i, '').trim();
      oddsStr = match[2]!;
    } else {
      // Fallback: "TeamName to win" with odds from linked <a> text
      const oddsMatch = (linkedOdds || '').match(/([+-]?\d+\.?\d*)\s*(?:at\s+.+)?/);
      if (!oddsMatch) return null;
      oddsStr = oddsMatch[1]!;
      // Remove the linked text from the pick text
      pickPart = text.replace(/\(.*\)/, '').replace(linkedOdds || '', '').trim();
      // Clean trailing "to win" etc
      pickPart = pickPart.replace(/\s+to\s+win\s*$/i, '').trim();
    }

    if (!pickPart) return null;

    // Detect pick type from the text
    const lower = pickPart.toLowerCase();

    if (lower.startsWith('over')) {
      return {
        team: pickPart,
        pickType: 'over_under',
        side: 'over',
        value: this.parseTotalValue(pickPart),
      };
    }
    if (lower.startsWith('under')) {
      return {
        team: pickPart,
        pickType: 'over_under',
        side: 'under',
        value: this.parseTotalValue(pickPart),
      };
    }

    // Check for spread: "TeamName -3.5" or "TeamName +2.5"
    const spreadMatch = pickPart.match(/^(.+?)\s+([+-]\d+\.?\d*)$/);
    if (spreadMatch) {
      return {
        team: spreadMatch[1]!.trim(),
        pickType: 'spread',
        side: 'home', // Will be resolved during normalization
        value: parseFloat(spreadMatch[2]!),
      };
    }

    // Check for props (contains specific player stats)
    if (/\d\+\s*(three|point|rebound|assist|steal|block)/i.test(pickPart)) {
      return {
        team: pickPart,
        pickType: 'prop',
        side: 'home',
        value: parseFloat(oddsStr),
      };
    }

    // Default: moneyline pick
    return {
      team: pickPart,
      pickType: 'moneyline',
      side: 'home',
      value: parseFloat(oddsStr),
    };
  }

  /**
   * Find the nearest matchup table above the current element.
   * Matchup tables have 3 columns: [TeamA, "", TeamB] where the middle is empty.
   * We collect all such tables in document order and pick the last one before
   * the best-bet element (i.e. the closest matchup above it).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private findNearestMatchup(
    $: ReturnType<typeof this.load>,
    bestBetEl: any,
  ): { home: string; away: string } | null {
    const tables = $('table.Covers-CoversArticles-AdminArticleTable');
    const allMatchups: { home: string; away: string; tableEl: any }[] = [];

    tables.each((_i, tableEl) => {
      const allHeaders = $(tableEl)
        .find('thead th')
        .map((_j, th) => $(th).text().trim())
        .get();

      // Matchup tables have exactly 3 columns with an empty middle header
      if (allHeaders.length === 3 && allHeaders[1] === '') {
        const away = allHeaders[0]!;
        const home = allHeaders[2]!;
        if (away && home) {
          allMatchups.push({ home, away, tableEl });
        }
      }
    });

    if (allMatchups.length === 0) return null;

    // Walk up from the best-bet element to find which matchup table precedes it.
    // We use a simple heuristic: get the source index of the best-bet element
    // and each table, then pick the last table whose index is before the bet.
    const betParent = $(bestBetEl).closest('p, div');
    const allEls = $('*');
    const betIndex = allEls.index(betParent.length ? betParent : bestBetEl);

    let closest: { home: string; away: string } | null = null;
    for (const m of allMatchups) {
      const tableIndex = allEls.index(m.tableEl);
      if (tableIndex < betIndex) {
        closest = { home: m.home, away: m.away };
      }
    }

    // Fallback: if no table is before the bet, return the first matchup
    return closest || { home: allMatchups[0]!.home, away: allMatchups[0]!.away };
  }

  private extractDateFromPage($: ReturnType<typeof this.load>): string {
    // Try to find date from timestamp
    const timestamp = $('[class*="timeStamp"]').text().trim();
    const dateMatch = timestamp.match(
      /(\w{3})\s+(\d{1,2}),?\s+(\d{4})/,
    );
    if (dateMatch) {
      const months: Record<string, string> = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04',
        May: '05', Jun: '06', Jul: '07', Aug: '08',
        Sep: '09', Oct: '10', Nov: '11', Dec: '12',
      };
      const m = months[dateMatch[1]!];
      const d = dateMatch[2]!.padStart(2, '0');
      if (m) return `${dateMatch[3]}-${m}-${d}`;
    }
    return new Date().toISOString().split('T')[0]!;
  }
}
