import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side } from '../types/prediction.js';

/**
 * Covers.com adapter.
 *
 * Covers uses a two-level structure:
 * 1. Landing page (/picks/nba) -> picks-card game cards with inline expert picks
 * 2. Each article page -> has best bet callouts + structured odds
 *
 * Landing page structure (as of 2026-02):
 *   - .picks-card: one per game, header has team abbreviations + game time
 *   - .pick-cards-expert-component: expert pick inside a picks-card
 *     - Badge: pick category (e.g. "Total Assists", "Points Scored")
 *     - Pick text: "Jalen Johnson o7.5 Total Assists (-145)"
 *     - Author: .card.profile-card .card-text a (e.g. "Quinn Allen")
 *     - Analysis: .compare-odds-analysis (reasoning text)
 *     - "Read Full Analysis" link -> article URL
 *
 * Article page structure (as of 2026-02):
 *   - Title: "Jazz vs Rockets Prediction, Picks & Best Bets..."
 *   - URL: /nba/jazz-vs-rockets-prediction-picks-best-bets-...
 *   - Best bet: `<strong>TeamA vs TeamB best bet</strong>: Pick text (-115)`
 *   - Odds list: `<li><strong>Spread</strong>: Away +13 (-110) | Home -13 (-110)</li>`
 *   - Author: `.covers-ArticleModern-authorName a`
 *   - Timestamp: `.covers-CoversArticles-timeStamp`
 */
export class CoversComAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'covers-com',
    name: 'Covers.com',
    baseUrl: 'https://www.covers.com',
    fetchMethod: 'http',
    paths: { nba: '/picks/nba' },
    cron: '0 */30 9-23 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  /**
   * Extract article URLs from the landing page.
   *
   * The new Covers landing page has:
   * - "Read Full Analysis" links inside .compare-odds-analysis sections
   * - Direct article links with patterns like /nba/team-vs-team-prediction-picks-...
   * - Computer picks links like /nba/team-vs-team-computer-picks-...
   */
  discoverUrls(html: string, _sport: string): string[] {
    const $ = this.load(html);
    const urls: string[] = [];
    const seen = new Set<string>();

    const addUrl = (href: string) => {
      const url = href.startsWith('http') ? href : `${this.config.baseUrl}${href}`;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    };

    // Primary: "Read Full Analysis" links inside analysis panels
    $('[data-linkcont*="Read Analysis"] a, a[data-linkcont*="Read Analysis"]').each((_i, el) => {
      const href = $(el).attr('href');
      if (href && /prediction|picks|best-bet|computer-picks/i.test(href)) {
        addUrl(href);
      }
    });

    // Secondary: any article-style links with prediction/picks keywords in href
    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href') || '';
      if (/\/nba\/[\w-]+-vs-[\w-]+-(?:prediction|picks|best-bet|computer-picks)/i.test(href)) {
        addUrl(href);
      }
    });

    return urls;
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);

    // Detect if this is the landing page or an article page
    const isLandingPage = $('.picks-card').length > 0;
    const isArticlePage = $('.covers-CoversArticles-articleText').length > 0
      || $('strong').filter((_i, el) => /best bet/i.test($(el).text())).length > 0;

    const predictions: RawPrediction[] = [];

    if (isLandingPage) {
      predictions.push(...this.parseLandingPage($, sport, fetchedAt));
    }

    if (isArticlePage) {
      predictions.push(...this.parseArticlePage($, sport, fetchedAt));
    }

    return predictions;
  }

  /**
   * Parse expert picks directly from the landing page.
   *
   * Each .picks-card has a game header (teams + time) and one or more
   * .pick-cards-expert-component elements with individual picks.
   */
  private parseLandingPage(
    $: ReturnType<typeof this.load>,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    $('.picks-card').each((_i, cardEl) => {
      const card = $(cardEl);

      // Extract teams from header: two .teams-component spans separated by "@"
      const teamSpans = card.find('.picks-card-header .teams-component');
      if (teamSpans.length < 2) return;

      const awayAbbr = $(teamSpans[0]).text().trim();
      const homeAbbr = $(teamSpans[1]).text().trim();

      // Extract team full names from logo alt text (e.g. "Washington Wizards logo")
      const awayAlt = $(teamSpans[0]).find('img').attr('alt') || '';
      const homeAlt = $(teamSpans[1]).find('img').attr('alt') || '';
      const awayTeam = awayAlt.replace(/\s*logo\s*$/i, '').trim() || awayAbbr;
      const homeTeam = homeAlt.replace(/\s*logo\s*$/i, '').trim() || homeAbbr;

      // Extract game date/time from header
      const dateTimeText = card.find('.picks-card-header .fs-12').text().trim();
      const gameDate = this.parseDateTimeText(dateTimeText);
      const gameTime = this.extractTimeFromText(dateTimeText);

      // Parse each expert pick component within this card
      card.find('.pick-cards-expert-component').each((_j, pickEl) => {
        const pickComp = $(pickEl);

        // Pick category badge (e.g., "Total Assists", "Points Scored", "Spread")
        const badge = pickComp.find('._badge').first().text().trim();

        // Pick description text: the bold text describing the actual pick
        // e.g., "Jalen Johnson o7.5 Total Assists (-145)"
        const pickTextEl = pickComp.find('.fw-bold.small, .fw-bold.small div').first();
        let pickText = '';
        if (pickTextEl.length) {
          // Get text content, skipping nested avatar elements
          pickText = pickTextEl.clone().find('.profile-avatar').remove().end().text().trim();
          // Clean up whitespace
          pickText = pickText.replace(/\s+/g, ' ').trim();
        }

        if (!pickText) return;

        // Author name
        const authorEl = pickComp.find('.profile-card .card-text a, [data-linkcont*="Author Name"]');
        const author = authorEl.first().text().trim() || 'Covers Expert';

        // Analysis/reasoning text
        const analysisEl = pickComp.find('.compare-odds-analysis');
        const reasoning = analysisEl.length
          ? analysisEl.text().replace(/Read Full Analysis.*$/, '').trim().slice(0, 200)
          : null;

        // Parse the pick text into structured data
        const parsed = this.parseLandingPickText(pickText, badge);
        if (!parsed) return;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate,
          gameTime,
          pickType: parsed.pickType,
          side: parsed.side,
          value: parsed.value,
          pickerName: author,
          confidence: 'medium',
          reasoning,
          fetchedAt,
        });
      });
    });

    return predictions;
  }

  /**
   * Parse picks from an individual article page.
   * Handles best-bet callouts and structured odds lists.
   */
  private parseArticlePage(
    $: ReturnType<typeof this.load>,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    // Author: try the modern article author container first, then legacy selector
    const author =
      $('.covers-ArticleModern-authorName a').first().text().trim() ||
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

  /**
   * Parse a landing page pick text like:
   *   "Jalen Johnson o7.5 Total Assists (-145)"
   *   "Kyshawn George o10.5 Points Scored (-115)"
   *   "Scottie Barnes Record a Double-Double (Yes: +135)"
   *   "Celtics -7 (-110)"
   */
  private parseLandingPickText(
    text: string,
    badge: string,
  ): { pickType: PickType; side: Side; value: number | null } | null {
    if (!text) return null;

    // Extract odds from parentheses
    const oddsMatch = text.match(/\(([^)]+)\)/);
    const pickText = text.replace(/\s*\([^)]*\)\s*/g, '').trim();

    // Over/under patterns: "o7.5", "u120.5", "Over 228.5", "Under 228.5"
    const ouMatch = pickText.match(/\b[ou](\d+\.?\d*)\b/i) || pickText.match(/\b(?:over|under)\s+(\d+\.?\d*)/i);
    if (ouMatch) {
      const isOver = /\bo/i.test(pickText) || /\bover\b/i.test(pickText);
      return {
        pickType: 'over_under',
        side: isOver ? 'over' : 'under',
        value: parseFloat(ouMatch[1]!),
      };
    }

    // Prop patterns: "Record a Double-Double", "2+ threes", etc.
    if (/double.double|triple.double|\d\+\s*(?:three|point|rebound|assist|steal|block)/i.test(pickText)) {
      const yesNo = oddsMatch?.[1]?.toLowerCase();
      const side: Side = yesNo?.startsWith('no') ? 'no' : 'yes';
      const val = oddsMatch?.[1]?.match(/([+-]?\d+)/);
      return {
        pickType: 'prop',
        side,
        value: val ? parseInt(val[1]!, 10) : null,
      };
    }

    // Spread pattern: "Team -7" or "Team +3.5"
    const spreadMatch = pickText.match(/^(.+?)\s+([+-]\d+\.?\d*)$/);
    if (spreadMatch) {
      return {
        pickType: 'spread',
        side: 'home',
        value: parseFloat(spreadMatch[2]!),
      };
    }

    // Badge-based inference for props
    const lowerBadge = badge.toLowerCase();
    if (
      lowerBadge.includes('assists') ||
      lowerBadge.includes('points') ||
      lowerBadge.includes('rebounds') ||
      lowerBadge.includes('steals') ||
      lowerBadge.includes('blocks') ||
      lowerBadge.includes('threes') ||
      lowerBadge.includes('double')
    ) {
      const val = oddsMatch?.[1]?.match(/([+-]?\d+)/);
      return {
        pickType: 'prop',
        side: 'over',
        value: val ? parseInt(val[1]!, 10) : null,
      };
    }

    // Default: moneyline
    const mlVal = oddsMatch?.[1]?.match(/([+-]?\d+)/);
    return {
      pickType: 'moneyline',
      side: 'home',
      value: mlVal ? parseInt(mlVal[1]!, 10) : null,
    };
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

    // Over/under with o/u prefix: "Payton Pritchard Over 19.5 points"
    // Also handle compact form: "o7.5 Total Assists"
    const ouMatch = pickText.match(/\b[ou](\d+\.?\d*)\b/i) || pickText.match(/\b(?:over|under)\s+(\d+\.?\d*)/i);
    if (ouMatch) {
      const isOver = /\bo/i.test(pickText) || /\bover\b/i.test(pickText);
      return { pickType: 'over_under', side: isOver ? 'over' : 'under', value: parseFloat(ouMatch[1]!) };
    }

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
    // URL pattern: /nba/wizards-vs-hawks-prediction-picks-best-bets-sgp-tuesday-2-24-2026
    // Team names don't contain these keyword segments, so split on them
    const canonical = $('link[rel="canonical"]').attr('href') || '';
    const vsMatch = canonical.match(/\/([a-z][a-z-]*)-vs-([a-z][a-z-]*)/i);
    if (vsMatch) {
      // Strip keyword suffixes from the home team segment
      const keywords = /-(prediction|picks|odds|best-bets?|computer|sgp|prop|projections)\b.*/i;
      const awaySlug = vsMatch[1]!.replace(keywords, '');
      const homeSlug = vsMatch[2]!.replace(keywords, '');
      const away = awaySlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const home = homeSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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
          // This is the favorite -- check if it's home or away
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
    // Try the article timestamp div
    const timestamp =
      $('.covers-CoversArticles-timeStamp').text().trim() ||
      $('[class*="timeStamp"]').text().trim();
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

  /**
   * Parse date from landing page header text like "Tue, Feb 24 * 7:30 PM ET"
   */
  private parseDateTimeText(text: string): string {
    const match = text.match(/(\w{3}),?\s+(\w{3})\s+(\d{1,2})/);
    if (!match) return new Date().toISOString().split('T')[0]!;

    const months: Record<string, string> = {
      Jan: '01', Feb: '02', Mar: '03', Apr: '04',
      May: '05', Jun: '06', Jul: '07', Aug: '08',
      Sep: '09', Oct: '10', Nov: '11', Dec: '12',
    };
    const m = months[match[2]!];
    const d = match[3]!.padStart(2, '0');
    if (!m) return new Date().toISOString().split('T')[0]!;

    // Infer year from current date
    const year = new Date().getFullYear();
    return `${year}-${m}-${d}`;
  }

  /**
   * Extract time from text like "Tue, Feb 24 * 7:30 PM ET"
   */
  private extractTimeFromText(text: string): string | null {
    const match = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)\s*ET)/i);
    return match ? match[1]!.trim() : null;
  }
}
