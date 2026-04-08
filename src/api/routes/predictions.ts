import type { FastifyPluginAsync } from 'fastify';
import { getAllBookingCodes } from '../booking-codes-scraper.js';
import { enrichMatches, hasFootballApi } from '../football-enrichment.js';
import { fotmobEnrichMatches } from '../fotmob-enrichment.js';
import { discoverCodes, getMutationStats } from '../code-mutator.js';
import { batchPinnacleOdds } from '../pinnacle-odds.js';
import { scanArbitrage } from '../arbitrage-scanner.js';
import { scrapeAllTipsters, findMatchingPredictions, buildConsensus } from '../tipster-scrapers.js';
// Lazy-loaded to avoid crashing when puppeteer is unavailable (e.g. Vercel)
const liveMonitor = () => import('../live-monitor.js');
const oddsportal = () => import('../oddsportal-scraper.js');
const oddsLagDetector = () => import('../odds-lag-detector.js');
const crossOddsScanner = () => import('../cross-odds-scanner.js');

// Strict alphanumeric pattern for booking codes
const CODE_PATTERN = /^[A-Za-z0-9]{4,8}$/;

// Validate a Sportybet event/market/outcome ID format
const BETRADAR_ID = /^sr:[a-z]+:\d+$/;
const NUMERIC_ID = /^\d+$/;

function isValidSelection(s: unknown): s is { eventId: string; marketId: string; outcomeId: string; specifier?: string; sportId: string } {
  if (!s || typeof s !== 'object') return false;
  const sel = s as Record<string, unknown>;
  if (typeof sel.eventId !== 'string' || !BETRADAR_ID.test(sel.eventId)) return false;
  if (typeof sel.marketId !== 'string' || !NUMERIC_ID.test(sel.marketId)) return false;
  if (typeof sel.outcomeId !== 'string' || !NUMERIC_ID.test(sel.outcomeId)) return false;
  if (typeof sel.sportId !== 'string' || !BETRADAR_ID.test(sel.sportId)) return false;
  if (sel.specifier !== undefined && typeof sel.specifier !== 'string') return false;
  if (typeof sel.specifier === 'string' && sel.specifier.length > 50) return false;
  return true;
}

export const predictionsRoutes: FastifyPluginAsync = async (app) => {

  // GET /predictions/track-codes?codes=ABC123,DEF456 — bulk live status
  app.get('/track-codes', async (request, reply) => {
    const { codes: codesParam } = request.query as { codes?: string };
    if (!codesParam || codesParam.length > 100) return reply.status(400).send({ error: 'Invalid input' });

    const codeList = codesParam.split(',')
      .map(c => c.trim().toUpperCase())
      .filter(c => CODE_PATTERN.test(c))
      .slice(0, 10);
    if (!codeList.length) return reply.status(400).send({ error: 'No valid codes' });

    const results = await Promise.allSettled(codeList.map(async (code) => {
      const res = await fetch(`https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { code, valid: false, selections: [] as unknown[], wonCount: 0, lostCount: 0, pendingCount: 0, totalOdds: 0, isDead: false, cashoutAdvice: 'Code not found' };

      const data = await res.json() as {
        bizCode: number;
        data?: {
          outcomes?: Array<{
            eventId: string; homeTeamName: string; awayTeamName: string;
            setScore?: string; matchStatus: string;
            sport: { id: string; category: { name: string; tournament: { name: string } } };
            markets: Array<{ id: string; desc: string; outcomes: Array<{ id: string; odds: string; desc: string; isWinning?: number }> }>;
          }>;
        };
      };

      if (data.bizCode !== 10000 || !data.data?.outcomes) {
        return { code, valid: false, selections: [] as unknown[], wonCount: 0, lostCount: 0, pendingCount: 0, totalOdds: 0, isDead: false, cashoutAdvice: 'Code not recognized' };
      }

      const selections = [];
      let totalOdds = 1;
      for (const o of data.data.outcomes) {
        const mkt = o.markets[0];
        if (!mkt?.outcomes[0]) continue;
        const sel = mkt.outcomes[0];
        const odds = parseFloat(sel.odds) || 1;
        totalOdds *= odds;
        selections.push({
          homeTeam: o.homeTeamName, awayTeam: o.awayTeamName,
          league: `${o.sport.category.name} - ${o.sport.category.tournament.name}`,
          market: mkt.desc, pick: sel.desc, odds,
          matchStatus: o.matchStatus || 'Unknown',
          isWinning: sel.isWinning ?? null, score: o.setScore || null,
        });
      }

      const wonCount = selections.filter(s => s.isWinning === 1).length;
      const lostCount = selections.filter(s => s.isWinning === 0).length;
      const pendingCount = selections.filter(s => s.isWinning === null).length;
      const total = selections.length;
      const isDead = lostCount > 0;

      let cashoutAdvice: string;
      if (isDead) cashoutAdvice = `Dead — ${lostCount} game${lostCount > 1 ? 's' : ''} lost`;
      else if (pendingCount === 0 && wonCount > 0) cashoutAdvice = 'All games won! Collect winnings';
      else if (wonCount > 0 && wonCount / total >= 0.7 && pendingCount <= 2) cashoutAdvice = `Consider cashout — ${wonCount}/${total} won, ${pendingCount} left`;
      else if (pendingCount === total) cashoutAdvice = 'All games pending';
      else cashoutAdvice = `${wonCount} won, ${pendingCount} pending`;

      return { code, valid: true, selections, wonCount, lostCount, pendingCount, totalOdds: Math.round(totalOdds * 100) / 100, isDead, cashoutAdvice };
    }));

    return { data: results.map(r => r.status === 'fulfilled' ? r.value : { code: '?', valid: false, selections: [], wonCount: 0, lostCount: 0, pendingCount: 0, totalOdds: 0, isDead: false, cashoutAdvice: 'Error' }) };
  });

  // GET /predictions/booking-codes — all Sportybet codes
  app.get('/booking-codes', async (_request, reply) => {
    const codes = await getAllBookingCodes();
    void reply.header('Cache-Control', 'public, max-age=900');
    return { data: codes, count: codes.length, generatedAt: new Date().toISOString() };
  });

  // GET /predictions/load-code/:code — load a single code from Sportybet
  app.get<{ Params: { code: string } }>('/load-code/:code', async (request, reply) => {
    const { code } = request.params;
    if (!code || !CODE_PATTERN.test(code)) {
      return reply.status(400).send({ error: 'Invalid code format' });
    }
    try {
      const res = await fetch(`https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      return await res.json();
    } catch {
      return reply.status(502).send({ error: 'Failed to reach Sportybet API' });
    }
  });

  // POST /predictions/create-code — create a Sportybet booking code
  app.post('/create-code', async (request, reply) => {
    const body = request.body as { selections?: unknown[] };
    if (!body?.selections || !Array.isArray(body.selections) || !body.selections.length) {
      return reply.status(400).send({ error: 'No selections provided' });
    }
    if (body.selections.length > 50) {
      return reply.status(400).send({ error: 'Too many selections (max 50)' });
    }
    // Validate every selection strictly — prevent arbitrary data being proxied
    const validated = [];
    for (const s of body.selections) {
      if (!isValidSelection(s)) {
        return reply.status(400).send({ error: 'Invalid selection format' });
      }
      validated.push({
        eventId: s.eventId,
        marketId: s.marketId,
        outcomeId: s.outcomeId,
        specifier: s.specifier || '',
        sportId: s.sportId,
      });
    }
    const payload = JSON.stringify({ selections: validated });
    const countries = ['ng', 'gh', 'ke', 'tz', 'zm', 'cm'];
    for (const cc of countries) {
      try {
        const res = await fetch(`https://www.sportybet.com/api/${cc}/orders/share`, {
          method: 'POST',
          headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
          body: payload,
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json() as { bizCode?: number; data?: { shareCode?: string }; message?: string };
        if (data.bizCode === 10000 && data.data?.shareCode) {
          return data;
        }
        // If last country also failed, return its error
        if (cc === countries[countries.length - 1]) {
          return data;
        }
      } catch {
        if (cc === countries[countries.length - 1]) {
          return reply.status(502).send({ error: 'Failed to reach Sportybet API' });
        }
      }
    }
    return reply.status(502).send({ error: 'All Sportybet endpoints failed' });
  });

  // POST /predictions/enrich — batch enrich matches with external data
  // Uses FotMob (no key needed) as primary, API-Football as fallback
  app.post('/enrich', async (request, reply) => {
    const body = request.body as { matches?: Array<{ homeTeam: string; awayTeam: string; matchDate: string | null; eventId: string }> };
    if (!body?.matches || !Array.isArray(body.matches)) {
      return reply.status(400).send({ error: 'No matches provided' });
    }

    // Limit to 25 matches per request
    const matches = body.matches.slice(0, 25);
    const data: Record<string, unknown> = {};

    // 1. Try FotMob first (no API key required)
    const fotmobResults = await fotmobEnrichMatches(matches);
    for (const [eventId, enrichment] of fotmobResults) {
      data[eventId] = enrichment;
    }

    // 2. Fill gaps with API-Football if key is available
    const missing = matches.filter(m => !data[m.eventId]);
    if (missing.length > 0 && hasFootballApi()) {
      const apiResults = await enrichMatches(missing);
      for (const [eventId, enrichment] of apiResults) {
        data[eventId] = enrichment;
      }
    }

    return { data, available: true, enriched: Object.keys(data).length, source: fotmobResults.size > 0 ? 'fotmob' : 'api-football' };
  });

  // POST /predictions/pinnacle — batch Pinnacle sharp odds for value detection
  app.post('/pinnacle', async (request, reply) => {
    const body = request.body as { matches?: Array<{ homeTeam: string; awayTeam: string; league: string; eventId: string }> };
    if (!body?.matches || !Array.isArray(body.matches)) {
      return reply.status(400).send({ error: 'No matches provided' });
    }

    const matches = body.matches.slice(0, 25);
    const odds = await batchPinnacleOdds(matches);

    const data: Record<string, unknown> = {};
    for (const [eventId, pinnOdds] of odds) {
      data[eventId] = pinnOdds;
    }

    return { data, matched: odds.size };
  });

  // GET /predictions/games — fetch pre-match football events with odds from Sportybet
  app.get('/games', async (request, reply) => {
    const query = request.query as { sportId?: string; timeline?: string; pageSize?: string; pageNum?: string };
    const sportId = query.sportId || 'sr:sport:1'; // football
    if (!BETRADAR_ID.test(sportId)) {
      return reply.status(400).send({ error: 'Invalid sportId' });
    }
    const isLive = query.timeline === 'live';
    const pageSize = Math.min(Math.max(parseInt(query.pageSize || '50', 10) || 50, 1), 100);
    const pageNum = Math.max(parseInt(query.pageNum || '1', 10) || 1, 1);
    // marketId: 1=1X2, 18=Over/Under, 29=GG/NG (Both Teams to Score)
    const marketId = '1,18,29';
    const ts = Date.now();

    const countries = ['ng', 'gh', 'ke', 'tz', 'zm', 'cm'];
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    for (const cc of countries) {
      try {
        const endpoint = isLive ? 'pcLiveEvents' : 'pcUpcomingEvents';
        const url = `https://www.sportybet.com/api/${cc}/factsCenter/${endpoint}?_t=${ts}&sportId=${encodeURIComponent(sportId)}&marketId=${encodeURIComponent(marketId)}&pageSize=${pageSize}&pageNum=${pageNum}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': ua },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) continue;
        const data = await res.json() as { bizCode?: number; data?: unknown };
        if (data.bizCode === 10000 && data.data) {
          void reply.header('Cache-Control', 'public, max-age=120');
          return { data: data.data, country: cc, timeline: isLive ? 'live' : 'prematch' };
        }
      } catch {
        // try next country
      }
    }
    return reply.status(502).send({ error: 'All Sportybet endpoints failed' });
  });

  // GET /predictions/cross-odds — compare ALL Pinnacle vs Sportybet odds (football + basketball)
  app.get('/cross-odds', async (_request, reply) => {
    try {
      const { scanCrossOdds } = await crossOddsScanner();
      return await scanCrossOdds();
    } catch (err) {
      return reply.status(502).send({ error: 'Cross odds scan failed' });
    }
  });

  // GET /predictions/odds-lag — detect stale Sportybet odds vs Pinnacle sharp moves
  app.get('/odds-lag', async (_request, reply) => {
    try {
      const { scanOddsLag } = await oddsLagDetector();
      return await scanOddsLag();
    } catch {
      return reply.status(502).send({ error: 'Odds lag scan failed' });
    }
  });

  // GET /predictions/live — live match monitor with Big Chance signals
  app.get('/live', async (_request, reply) => {
    try {
      const { scrapeLiveMonitor } = await liveMonitor();
      const data = await scrapeLiveMonitor();
      return data;
    } catch {
      return reply.status(502).send({ error: 'Live monitor failed' });
    }
  });

  // GET /predictions/live/cached — get cached live data without scraping
  app.get('/live/cached', async (_request, reply) => {
    try {
      const { getLiveData } = await liveMonitor();
      return getLiveData();
    } catch {
      return { matches: [], signals: [], scrapedAt: 0 };
    }
  });

  // POST /predictions/discover — discover new codes by mutating known codes
  app.post('/discover', async (request, reply) => {
    const body = request.body as { seeds?: string[]; maxResults?: number };
    if (!body?.seeds || !Array.isArray(body.seeds) || !body.seeds.length) {
      return reply.status(400).send({ error: 'No seed codes provided' });
    }

    // Validate seed codes
    const seeds = body.seeds
      .map(s => String(s).trim().toUpperCase())
      .filter(s => /^[A-Z0-9]{6}$/.test(s))
      .slice(0, 50); // max 50 seeds per request

    if (!seeds.length) {
      return reply.status(400).send({ error: 'No valid 6-character codes' });
    }

    const maxResults = Math.min(body.maxResults || 15, 200);
    const discovered = await discoverCodes(seeds, maxResults);

    return {
      data: discovered,
      count: discovered.length,
      seeds: seeds.length,
      stats: getMutationStats(),
    };
  });

  // GET /predictions/arbitrage — scan for arb & value bet opportunities
  app.get('/arbitrage', async (_request, reply) => {
    const result = await scanArbitrage();
    reply.header('Cache-Control', 'public, max-age=600');
    return result;
  });

  // GET /predictions/oddsportal — scrape today's football odds from OddsPortal (multi-bookmaker)
  app.get('/oddsportal', async (request, reply) => {
    try {
      const { date } = request.query as { date?: string };
      const { scrapeOddsPortal } = await oddsportal();
      const result = await scrapeOddsPortal(date);
      void reply.header('Cache-Control', 'public, max-age=900');
      return result;
    } catch {
      return reply.status(502).send({ error: 'OddsPortal scrape failed' });
    }
  });

  // GET /predictions/oddsportal/match — detailed per-bookmaker odds for a specific match
  app.get('/oddsportal/match', async (request, reply) => {
    const { url } = request.query as { url?: string };
    if (!url || !url.startsWith('https://www.oddsportal.com/')) {
      return reply.status(400).send({ error: 'Provide a valid OddsPortal match URL' });
    }
    try {
      const { scrapeMatchOdds } = await oddsportal();
      const result = await scrapeMatchOdds(url);
      if (!result) return reply.status(404).send({ error: 'Match not found or no odds' });
      return { data: result };
    } catch {
      return reply.status(502).send({ error: 'OddsPortal match scrape failed' });
    }
  });

  // GET /predictions/tipster-consensus — aggregated predictions from 6 tipster sites
  app.get('/tipster-consensus', async (request, reply) => {
    const query = request.query as { home?: string; away?: string };

    // Scrape all sources (cached for 30 min)
    const allPredictions = await scrapeAllTipsters();

    // If specific match requested, return consensus for that match
    if (query.home && query.away) {
      const matched = findMatchingPredictions(allPredictions, query.home, query.away);
      const consensus = buildConsensus(matched, query.home, query.away);
      return { data: consensus, matched: matched.length, sources: [...new Set(matched.map(m => m.source))] };
    }

    // Otherwise return all predictions grouped by source
    const bySource: Record<string, number> = {};
    for (const p of allPredictions) {
      bySource[p.source] = (bySource[p.source] || 0) + 1;
    }

    void reply.header('Cache-Control', 'public, max-age=900');
    return {
      data: allPredictions,
      count: allPredictions.length,
      sources: bySource,
      scrapedAt: new Date().toISOString(),
    };
  });

  // POST /predictions/tipster-consensus — match multiple games against tipster data
  app.post('/tipster-consensus', async (request) => {
    const body = request.body as {
      matches?: Array<{
        homeTeam: string;
        awayTeam: string;
        odds?: { home?: number; draw?: number; away?: number; over25?: number; under25?: number };
      }>;
    };
    if (!body?.matches || !Array.isArray(body.matches)) {
      return { error: 'Provide matches array with homeTeam/awayTeam' };
    }

    const allPredictions = await scrapeAllTipsters();
    const results = body.matches.slice(0, 50).map((m) => {
      const matched = findMatchingPredictions(allPredictions, m.homeTeam, m.awayTeam);
      return {
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        consensus: buildConsensus(matched, m.homeTeam, m.awayTeam, m.odds),
        matchedSources: matched.length,
      };
    });

    return {
      data: results,
      totalPredictions: allPredictions.length,
      sourcesAvailable: [...new Set(allPredictions.map((p) => p.source))],
    };
  });
};
