import type { FastifyPluginAsync } from 'fastify';
import { getAllBookingCodes } from '../booking-codes-scraper.js';
import { enrichMatches, hasFootballApi } from '../football-enrichment.js';
import { fotmobEnrichMatches } from '../fotmob-enrichment.js';
import { discoverCodes, getMutationStats } from '../code-mutator.js';
import { batchPinnacleOdds } from '../pinnacle-odds.js';
import { scrapeVirtuals } from '../virtual-scraper.js';
import {
  scrapeResults as scrapeVirtualResults,
  getAllStats as getVirtualStats,
  predictMatch as predictVirtualMatch,
  getResultsCount as getVirtualResultsCount,
  getRecentResults as getVirtualRecentResults,
} from '../virtual-results.js';

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
    const countries = ['ng', 'gh', 'ke', 'tz', 'zm'];
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

    const countries = ['ng', 'gh', 'ke', 'tz', 'zm'];
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

  // GET /predictions/virtuals — scrape virtual football from Golden Race
  app.get('/virtuals', async (_request, reply) => {
    try {
      const leagues = await scrapeVirtuals();
      void reply.header('Cache-Control', 'public, max-age=90');
      return {
        data: leagues,
        count: leagues.length,
        matches: leagues.reduce((s, l) => s + l.matches.length, 0),
      };
    } catch {
      return reply.status(502).send({ error: 'Failed to scrape virtual games' });
    }
  });

  // GET /predictions/virtual-stats — team stats from collected virtual results
  app.get('/virtual-stats', async (request) => {
    const { country } = request.query as { country?: string };
    const stats = getVirtualStats();
    const resultsCount = getVirtualResultsCount();
    if (country) {
      return { data: stats[country] || [], resultsCount, country };
    }
    return { data: stats, resultsCount };
  });

  // GET /predictions/virtual-predict — predict upcoming virtual matches
  app.get('/virtual-predict', async (request, reply) => {
    const { matches } = request.query as { matches?: string };
    if (!matches) return reply.status(400).send({ error: 'Provide matches as JSON array' });
    try {
      const parsed = JSON.parse(matches) as Array<{ home: string; away: string; country: string }>;
      const predictions = parsed
        .slice(0, 50)
        .map((m) => predictVirtualMatch(m.home, m.away, m.country))
        .filter(Boolean);
      return { data: predictions, resultsCount: getVirtualResultsCount() };
    } catch {
      return reply.status(400).send({ error: 'Invalid matches format' });
    }
  });

  // GET /predictions/virtual-results — recent results
  app.get('/virtual-results', async (request) => {
    const { country, limit } = request.query as { country?: string; limit?: string };
    const results = getVirtualRecentResults(country, parseInt(limit || '50', 10));
    return { data: results, total: getVirtualResultsCount() };
  });

  // POST /predictions/virtual-collect — trigger a results collection
  app.post('/virtual-collect', async (_request, reply) => {
    try {
      const results = await scrapeVirtualResults();
      return { collected: results.length, total: getVirtualResultsCount() };
    } catch {
      return reply.status(502).send({ error: 'Failed to collect virtual results' });
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
};
