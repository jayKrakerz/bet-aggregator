import { fetchBrowser } from '../workers/browser-pool.js';
import { parseSoccer24Feed, toRawGameResults } from './soccer24-parser.js';
import type { RawGameResult } from '../types/result.js';
import { logger } from '../utils/logger.js';

const SOCCER24_BASE = 'https://www.soccer24.com';

/**
 * Major leagues to fetch results for.
 * robots.txt allows /results/ paths for league pages.
 */
const LEAGUE_PATHS: Record<string, string> = {
  'epl': '/england/premier-league',
  'laliga': '/spain/laliga',
  'bundesliga': '/germany/bundesliga',
  'serie-a': '/italy/serie-a',
  'ligue-1': '/france/ligue-1',
};

/**
 * Fetch football match results from Soccer24 for a given date.
 * Uses Playwright since Soccer24 is a JavaScript SPA (Flashscore engine).
 * Tries two extraction strategies:
 *   1. Extract cjs.initialFeeds from page JS context
 *   2. Fallback to parsing rendered DOM elements
 */
export async function fetchSoccer24Results(dateStr: string): Promise<RawGameResult[]> {
  const log = logger.child({ source: 'soccer24', date: dateStr });
  const allResults: RawGameResult[] = [];

  for (const [league, path] of Object.entries(LEAGUE_PATHS)) {
    const url = `${SOCCER24_BASE}${path}/results/`;

    try {
      const results = await fetchLeagueResults(url, dateStr);
      allResults.push(...results);
      log.info({ league, count: results.length }, 'Soccer24 results fetched');
    } catch (err) {
      log.warn({ league, err }, 'Soccer24 fetch failed for league');
    }
  }

  log.info({ total: allResults.length }, 'Soccer24 results complete');
  return allResults;
}

async function fetchLeagueResults(url: string, dateStr: string): Promise<RawGameResult[]> {
  const html = await fetchBrowser(url, async (page) => {
    // Wait for match data to render
    await page.waitForSelector('[class*="event__match"]', { timeout: 15000 }).catch(() => {});
  });

  // Strategy 1: Extract pipe-delimited feed data from script tags
  const feedResults = extractFromFeed(html, dateStr);
  if (feedResults.length > 0) return feedResults;

  // Strategy 2: Extract via Playwright page evaluation of rendered DOM
  // (this path uses the already-fetched HTML which contains the rendered DOM)
  return extractFromDom(html, dateStr);
}

/**
 * Strategy 1: Extract match data from cjs.initialFeeds embedded in <script> tags.
 * Soccer24/Flashscore bootstraps initial data as pipe-delimited strings in inline JS.
 */
function extractFromFeed(html: string, dateStr: string): RawGameResult[] {
  // The feed data is typically in a script tag like:
  //   cjs.initialFeeds["results"] = "SA÷1¬~ZA÷..."
  // or assigned to a variable
  const feedPatterns = [
    /cjs\.initialFeeds\[["']results["']\]\s*=\s*"((?:[^"\\]|\\.)*)"/,
    /cjs\.initialFeeds\[["'][\w-]+["']\]\s*=\s*"((?:[^"\\]|\\[\s\S])*)"/g,
    /(?:feed|data)\s*=\s*"(SA÷[\s\S]*?)"/,
  ];

  for (const pattern of feedPatterns) {
    const isGlobal = pattern.global;

    if (isGlobal) {
      let match: RegExpExecArray | null;
      const allMatches: RawGameResult[] = [];
      while ((match = pattern.exec(html)) !== null) {
        const decoded = match[1]!
          .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
        const parsed = parseSoccer24Feed(decoded);
        const results = toRawGameResults(parsed);
        allMatches.push(...filterByDate(results, dateStr));
      }
      if (allMatches.length > 0) return allMatches;
    } else {
      const match = html.match(pattern);
      if (match?.[1]) {
        const decoded = match[1]
          .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
        const parsed = parseSoccer24Feed(decoded);
        const results = toRawGameResults(parsed);
        const filtered = filterByDate(results, dateStr);
        if (filtered.length > 0) return filtered;
      }
    }
  }

  return [];
}

/**
 * Strategy 2: Parse match data from the rendered DOM.
 * Flashscore/Soccer24 renders matches with predictable CSS class patterns.
 */
function extractFromDom(html: string, dateStr: string): RawGameResult[] {
  const results: RawGameResult[] = [];

  // Date headers in Flashscore look like "24.02.2026" or "24.02."
  // Match blocks follow under each date header
  // We look for patterns in the rendered HTML

  // Match pattern: home team, away team, scores
  // Flashscore DOM: event__participant--home, event__participant--away, event__scores
  const matchRegex = /event__participant[^>]*--home[^>]*>([^<]+)<[\s\S]*?event__participant[^>]*--away[^>]*>([^<]+)<[\s\S]*?event__score[^>]*--home[^>]*>(\d+)<[\s\S]*?event__score[^>]*--away[^>]*>(\d+)</g;

  let match: RegExpExecArray | null;
  while ((match = matchRegex.exec(html)) !== null) {
    const homeTeam = match[1]!.trim();
    const awayTeam = match[2]!.trim();
    const homeScore = parseInt(match[3]!, 10);
    const awayScore = parseInt(match[4]!, 10);

    if (homeTeam && awayTeam && !isNaN(homeScore) && !isNaN(awayScore)) {
      results.push({
        sport: 'football',
        homeTeamName: homeTeam,
        awayTeamName: awayTeam,
        homeScore,
        awayScore,
        gameDate: dateStr,
        status: 'final',
      });
    }
  }

  return results;
}

function filterByDate(results: RawGameResult[], dateStr: string): RawGameResult[] {
  return results.filter((r) => r.gameDate === dateStr);
}
