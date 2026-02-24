import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side } from '../types/prediction.js';

/**
 * Covers.com adapter.
 *
 * Covers uses a two-level structure:
 * 1. Landing page (/nba/picks) → lists article links
 * 2. Each article page → has best bet callouts + structured odds
 *
 * Article structure (as of 2026-02):
 *   - Title: "Jazz vs Rockets Prediction, Picks & Best Bets..."
 *   - URL: /nba/jazz-vs-rockets-prediction-picks-best-bets-...
 *   - `<strong>TeamA vs TeamB best bet</strong>: Pick text here (-115)`
 *   - Odds list `<li><strong>Spread</strong>: Away +13 (-110) | Home -13 (-110)</li>`
 *   - Author: `[class*="authorName"]`
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
   * Look for links that match pick/prediction/best-bet URL patterns.
   */
  discoverUrls(html: string, _sport: string): string[] {
    const $ = this.load(html);
    const urls: string[] = [];
    const seen = new Set<string>();

    // Primary: article elements
    $('article a[href], .single-article-LH a[href]').each((_i, el) => {
      const href = $(el).attr('href');
      if (href && /pick|prediction|odds|best-bet/i.test(href)) {
        const url = href.startsWith('http') ? href : `${this.config.baseUrl}${href}`;
        if (!seen.has(url)) {
          seen.add(url);
          urls.push(url);
        }
      }
    });

    // Fallback: any link with prediction keywords in the path
    if (urls.length === 0) {
      $('a[href]').each((_i, el) => {
        const href = $(el).attr('href') || '';
        if (/\/nba\/.*(?:prediction|picks|best-bet)/i.test(href) && !href.includes('/picks/nba')) {
          const url = href.startsWith('http') ? href : `${this.config.baseUrl}${href}`;
          if (!seen.has(url)) {
            seen.add(url);
            urls.push(url);
          }
        }
      });
    }

    return urls;
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    const author =
      $('[class*="authorName"]').first().text().trim().split('\n')[0]?.trim() ||
      'Covers Expert';

    const gameDate = this.extractDateFromPage($);
    const matchup = this.extractMatchupFromPage($);

    // Extract best bet callouts
    $('strong, b').each((_i, el) => {
      const strongText = $(el).text().trim();
      if (!/best bet/i.test(strongText)) return;

      // Get text AFTER the strong tag (not the full parent text minus strong)
      const parent = $(el).parent();
      const strongOriginal = $(el).text();
      const parentText = parent.text().trim();

      // Extract pick text: everything after the strong element + colon
      const afterStrong = parentText.substring(
        parentText.indexOf(strongOriginal) + strongOriginal.length,
      ).replace(/^:\s*/, '').trim();

      if (!afterStrong) return;

      const parsed = this.parseBestBetText(afterStrong);
      if (!parsed) return;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup?.home || '',
        awayTeamRaw: matchup?.away || '',
        gameDate,
        gameTime: null,
        pickType: parsed.pickType,
        side: parsed.side,
        value: parsed.value,
        pickerName: author,
        confidence: 'best_bet',
        reasoning: afterStrong.slice(0, 200),
        fetchedAt,
      });
    });

    // Also extract structured odds from list items
    // Format: <li><strong>Spread</strong>: Jazz +13 (-110) | Rockets -13 (-110)</li>
    if (matchup) {
      $('li').each((_i, el) => {
        const li = $(el);
        const strong = li.find('strong').text().trim().toLowerCase();
        const fullText = li.text().trim();

        if (strong === 'spread') {
          const spreadPick = this.parseSpreadLine(fullText, matchup);
          if (spreadPick) {
            predictions.push({
              sourceId: this.config.id,
              sport,
              homeTeamRaw: matchup.home,
              awayTeamRaw: matchup.away,
              gameDate,
              gameTime: null,
              pickType: 'spread',
              side: spreadPick.side,
              value: spreadPick.value,
              pickerName: author,
              confidence: null,
              reasoning: fullText.slice(0, 200),
              fetchedAt,
            });
          }
        } else if (strong === 'moneyline') {
          const mlPick = this.parseMoneylineLine(fullText, matchup);
          if (mlPick) {
            predictions.push({
              sourceId: this.config.id,
              sport,
              homeTeamRaw: matchup.home,
              awayTeamRaw: matchup.away,
              gameDate,
              gameTime: null,
              pickType: 'moneyline',
              side: mlPick.side,
              value: mlPick.value,
              pickerName: author,
              confidence: null,
              reasoning: fullText.slice(0, 200),
              fetchedAt,
            });
          }
        } else if (strong === 'over/under' || strong === 'total') {
          const ouPick = this.parseOverUnderLine(fullText);
          if (ouPick) {
            predictions.push({
              sourceId: this.config.id,
              sport,
              homeTeamRaw: matchup.home,
              awayTeamRaw: matchup.away,
              gameDate,
              gameTime: null,
              pickType: 'over_under',
              side: ouPick.side,
              value: ouPick.value,
              pickerName: author,
              confidence: null,
              reasoning: fullText.slice(0, 200),
              fetchedAt,
            });
          }
        }
      });
    }

    return predictions;
  }

  private parseBestBetText(text: string): {
    pickType: PickType;
    side: Side;
    value: number | null;
  } | null {
    // Extract odds from parentheses: "Rockets team total Under 120.5 (-115)"
    const oddsMatch = text.match(/\(([+-]?\d+\.?\d*)\s*(?:at\s+.+?)?\)/);
    const pickText = text.replace(/\s*\([^)]*\)\s*/g, '').trim();

    if (!pickText) return null;

    const lower = pickText.toLowerCase();

    // Over/under: "Under 120.5" or "Over 228.5"
    if (/\bunder\b/i.test(lower)) {
      return { pickType: 'over_under', side: 'under', value: this.parseTotalValue(pickText) };
    }
    if (/\bover\b/i.test(lower)) {
      return { pickType: 'over_under', side: 'over', value: this.parseTotalValue(pickText) };
    }

    // Spread: "TeamName -3.5"
    const spreadMatch = pickText.match(/^(.+?)\s+([+-]\d+\.?\d*)$/);
    if (spreadMatch) {
      return { pickType: 'spread', side: 'home', value: parseFloat(spreadMatch[2]!) };
    }

    // Props: "Player 2+ threes" etc
    if (/\d\+\s*(three|point|rebound|assist|steal|block)/i.test(pickText)) {
      return {
        pickType: 'prop',
        side: 'home',
        value: oddsMatch ? parseFloat(oddsMatch[1]!) : null,
      };
    }

    // Default: moneyline
    return {
      pickType: 'moneyline',
      side: 'home',
      value: oddsMatch ? parseFloat(oddsMatch[1]!) : null,
    };
  }

  /**
   * Extract team names from the page title or canonical URL.
   * URL pattern: /nba/jazz-vs-rockets-prediction-...
   * Title pattern: "Jazz vs Rockets Prediction, Picks..."
   */
  private extractMatchupFromPage($: ReturnType<typeof this.load>): { home: string; away: string } | null {
    // Try canonical URL first: more reliable
    const canonical = $('link[rel="canonical"]').attr('href') || '';
    const urlMatch = canonical.match(/\/([a-z-]+)-vs-([a-z-]+)-(?:prediction|picks|odds|best-bet)/i);
    if (urlMatch) {
      const away = urlMatch[1]!.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const home = urlMatch[2]!.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return { away, home };
    }

    // Fallback: page title
    const title = $('title').text().trim();
    const titleMatch = title.match(/^(.+?)\s+vs\.?\s+(.+?)\s+(?:prediction|picks|odds)/i);
    if (titleMatch) {
      return { away: titleMatch[1]!.trim(), home: titleMatch[2]!.trim() };
    }

    return null;
  }

  /**
   * Parse "Spread: Jazz +13 (-110) | Rockets -13 (-110)"
   * Returns the favorite's side (team with negative spread).
   */
  private parseSpreadLine(text: string, matchup: { home: string; away: string }): { side: Side; value: number } | null {
    // Find all "TeamName [+-]N.N" patterns
    const parts = text.split('|');
    for (const part of parts) {
      const m = part.match(/([+-]\d+\.?\d*)\s*\(/);
      if (m) {
        const val = parseFloat(m[1]!);
        if (val < 0) {
          // This is the favorite — check if it's home or away
          const isHome = part.toLowerCase().includes(matchup.home.toLowerCase().split(' ').pop()!);
          return { side: isHome ? 'home' : 'away', value: val };
        }
      }
    }
    return null;
  }

  /**
   * Parse "Moneyline: Jazz +575 | Rockets -850"
   * Returns the favorite side.
   */
  private parseMoneylineLine(text: string, matchup: { home: string; away: string }): { side: Side; value: number } | null {
    const parts = text.split('|');
    for (const part of parts) {
      const m = part.match(/([+-]\d+)/);
      if (m) {
        const val = parseInt(m[1]!, 10);
        if (val < 0) {
          const isHome = part.toLowerCase().includes(matchup.home.toLowerCase().split(' ').pop()!);
          return { side: isHome ? 'home' : 'away', value: val };
        }
      }
    }
    return null;
  }

  /**
   * Parse "Over/Under: Over 228.5 (-110) | Under 228.5 (-110)"
   */
  private parseOverUnderLine(text: string): { side: Side; value: number } | null {
    const totalMatch = text.match(/([\d.]+)/);
    if (!totalMatch) return null;
    return { side: 'over', value: parseFloat(totalMatch[1]!) };
  }

  private extractDateFromPage($: ReturnType<typeof this.load>): string {
    // Try to find date from timestamp
    const timestamp = $('[class*="timeStamp"]').text().trim();
    const dateMatch = timestamp.match(/(\w{3})\s+(\d{1,2}),?\s+(\d{4})/);
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

    // Try publication date from schema
    const pubDate = $('meta[property="article:published_time"]').attr('content')
      || $('script[type="application/ld+json"]').text().match(/"datePublished":"([^"]+)"/)?.[1];
    if (pubDate) {
      const d = new Date(pubDate);
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0]!;
    }

    return new Date().toISOString().split('T')[0]!;
  }
}
