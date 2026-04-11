import type { FastifyPluginAsync } from 'fastify';
import { getAllBookingCodes } from '../booking-codes-scraper.js';
import { enrichMatches, hasFootballApi } from '../football-enrichment.js';
import { fotmobEnrichMatches } from '../fotmob-enrichment.js';
import { discoverCodes, getMutationStats } from '../code-mutator.js';
import { batchPinnacleOdds } from '../pinnacle-odds.js';
import { scanArbitrage } from '../arbitrage-scanner.js';
import { scrapeAllTipsters, findMatchingPredictions, buildConsensus } from '../tipster-scrapers.js';
import { snapshotConsensus, settleResults, getStats, getAllPicks, startAutoTracker, getSourceWeights } from '../consensus-tracker.js';
import { getCodePerformance, getLearnedWeights } from '../code-performance-tracker.js';
import { predictMatch, predictMatches, preloadLeagueData, getAvailableTeams } from '../stats-predictor.js';
let _aviatorModule: typeof import('../aviator-tracker.js') | null = null;
const aviatorTracker = async () => {
  if (!_aviatorModule) _aviatorModule = await import('../aviator-tracker.js');
  return _aviatorModule;
};
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
  // Optional ?threshold=-1 query param to tune Pinnacle move sensitivity (default -2%).
  app.get('/odds-lag', async (request, reply) => {
    try {
      const { threshold } = request.query as { threshold?: string };
      const t = threshold !== undefined ? Number(threshold) : undefined;
      const safeThreshold = t !== undefined && Number.isFinite(t) && t <= 0 && t >= -20 ? t : undefined;
      const { scanOddsLag } = await oddsLagDetector();
      return await scanOddsLag(safeThreshold);
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
  app.get('/live/cached', async (_request, _reply) => {
    try {
      const { getLiveData } = await liveMonitor();
      return getLiveData();
    } catch {
      return { matches: [], signals: [], scrapedAt: 0 };
    }
  });

  // GET /predictions/live/signals — compact signal map for safety scoring
  app.get('/live/signals', async (_request, reply) => {
    try {
      const { getSignalMap } = await liveMonitor();
      void reply.header('Cache-Control', 'public, max-age=30');
      return { data: getSignalMap() };
    } catch {
      return { data: {} };
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

  // POST /predictions/tipster-consensus — match multiple games against tipster data + Poisson model
  app.post('/tipster-consensus', async (request) => {
    const body = request.body as {
      matches?: Array<{
        homeTeam: string;
        awayTeam: string;
        league?: string;
        odds?: { home?: number; draw?: number; away?: number; over25?: number; under25?: number };
      }>;
    };
    if (!body?.matches || !Array.isArray(body.matches)) {
      return { error: 'Provide matches array with homeTeam/awayTeam' };
    }

    const allPredictions = await scrapeAllTipsters();

    // Per-source Bayesian-shrunk weights from the consensus tracker.
    // Tipsters with a stronger historical track record get more influence.
    const weights = getSourceWeights();

    // Batch Poisson predictions for all matches
    const poissonResults = await predictMatches(
      body.matches.slice(0, 50).map((m) => ({ homeTeam: m.homeTeam, awayTeam: m.awayTeam, league: m.league })),
    );

    const results = body.matches.slice(0, 50).map((m) => {
      const matched = findMatchingPredictions(allPredictions, m.homeTeam, m.awayTeam);

      // Inject Poisson model as an extra tipster source if available
      const poisson = poissonResults.get(`${m.homeTeam} vs ${m.awayTeam}`);
      if (poisson && poisson.confidence >= 25) {
        matched.push({
          source: 'poisson-model',
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          date: new Date().toISOString().slice(0, 10),
          time: '',
          homePct: poisson.homePct,
          drawPct: poisson.drawPct,
          awayPct: poisson.awayPct,
          over25Pct: poisson.over25Pct,
          under25Pct: poisson.under25Pct,
          btsPct: poisson.btsPct,
          otsPct: 100 - poisson.btsPct,
        });
      }

      return {
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        consensus: buildConsensus(matched, m.homeTeam, m.awayTeam, m.odds, weights),
        matchedSources: matched.length,
        poissonModel: poisson || null,
      };
    });

    return {
      data: results,
      totalPredictions: allPredictions.length,
      sourcesAvailable: [...new Set(allPredictions.map((p) => p.source)), 'poisson-model'],
    };
  });

  // ── Consensus Result Tracker ─────────────────────────────

  // Start background auto-tracker on first load
  startAutoTracker();

  // GET /predictions/consensus-results — performance stats
  app.get('/consensus-results', async () => {
    return getStats();
  });

  // GET /predictions/consensus-picks — all tracked picks
  app.get('/consensus-picks', async (request) => {
    const { filter } = request.query as { filter?: 'pending' | 'won' | 'lost' };
    const valid = ['pending', 'won', 'lost'] as const;
    const f = filter && valid.includes(filter) ? filter : undefined;
    return { data: getAllPicks(f) };
  });

  // POST /predictions/consensus-snapshot — manually snapshot current consensus
  app.post('/consensus-snapshot', async (request) => {
    const body = request.body as { minSources?: number; minPct?: number } | null;
    const minSources = body?.minSources ?? 2;
    const minPct = body?.minPct ?? 50;
    const added = await snapshotConsensus(minSources, minPct);
    return { added: added.length, total: getAllPicks().length, picks: added };
  });

  // POST /predictions/consensus-settle — manually trigger result settlement
  app.post('/consensus-settle', async () => {
    const result = await settleResults();
    return { ...result, stats: getStats() };
  });

  // GET /predictions/code-performance — booking code win/loss/ROI stats by source, odds, market
  app.get('/code-performance', async (_request, reply) => {
    const data = await getCodePerformance();
    void reply.header('Cache-Control', 'public, max-age=300');
    return data;
  });

  // GET /predictions/learned-weights — aggregated win rates for the frontend's safety scoring
  app.get('/learned-weights', async (_request, reply) => {
    const data = await getLearnedWeights();
    void reply.header('Cache-Control', 'public, max-age=600');
    return data;
  });

  // ── Poisson Stats Predictor ──────────────────────────────

  // Preload historical data on startup
  void preloadLeagueData();

  // GET /predictions/poisson?home=Barcelona&away=Atletico+Madrid&league=La+Liga
  app.get('/poisson', async (request, reply) => {
    const { home, away, league } = request.query as { home?: string; away?: string; league?: string };
    if (!home || !away) return reply.status(400).send({ error: 'Provide home and away team names' });
    const prediction = await predictMatch(home, away, league);
    if (!prediction) return reply.status(404).send({ error: 'No data for this match — league may not be covered or team names not matched' });
    return { data: prediction };
  });

  // POST /predictions/poisson — batch predict matches
  app.post('/poisson', async (request, reply) => {
    const body = request.body as { matches?: Array<{ homeTeam: string; awayTeam: string; league?: string }> };
    if (!body?.matches || !Array.isArray(body.matches)) {
      return reply.status(400).send({ error: 'Provide matches array with homeTeam/awayTeam' });
    }
    const results = await predictMatches(body.matches.slice(0, 50));
    const data = Object.fromEntries(results);
    return { data, matched: results.size, total: body.matches.length };
  });

  // GET /predictions/poisson/teams — list all teams with stats data available
  app.get('/poisson/teams', async (_request, reply) => {
    const teams = getAvailableTeams();
    void reply.header('Cache-Control', 'public, max-age=3600');
    return { data: teams, count: teams.length };
  });

  // ── Aviator Tracker ──────────────────────────────────────

  // POST /predictions/aviator/start — open Aviator in browser and start tracking
  app.post('/aviator/start', async () => {
    try {
      const { startAviator } = await aviatorTracker();
      return await startAviator();
    } catch (err) {
      return { success: false, message: `Failed: ${err}` };
    }
  });

  // POST /predictions/aviator/stop — stop tracking
  app.post('/aviator/stop', async () => {
    try {
      const { stopAviator } = await aviatorTracker();
      await stopAviator();
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  // GET /predictions/aviator — get current state, history, signals
  app.get('/aviator', async () => {
    try {
      const { getAviatorState } = await aviatorTracker();
      return getAviatorState();
    } catch {
      return { running: false, connected: false, history: [], signals: [], stats: { total: 0, avg: 0, median: 0, above2x: 0, above5x: 0, above10x: 0, lastLowStreak: 0, recentAvg: 0 }, lastUpdate: 0 };
    }
  });

  // GET /predictions/aviator/history — full crash history
  app.get('/aviator/history', async () => {
    try {
      const { getFullHistory } = await aviatorTracker();
      return { data: getFullHistory() };
    } catch {
      return { data: [] };
    }
  });

  // GET /predictions/aviator/predictions — prediction accuracy log
  app.get('/aviator/predictions', async () => {
    try {
      const { getPredictions } = await aviatorTracker();
      return { data: getPredictions() };
    } catch {
      return { data: [] };
    }
  });

  // GET /predictions/aviator/backtest — replay strategies against full history
  app.get('/aviator/backtest', async () => {
    try {
      const { runBacktestSuite } = await aviatorTracker();
      return { data: runBacktestSuite() };
    } catch (err) {
      return { data: [], error: String(err) };
    }
  });

  // ── Auto-Bet Endpoints ──────────────────────────────────

  // POST /predictions/aviator/autobet/start — start auto-betting
  app.post('/aviator/autobet/start', async (request, reply) => {
    const body = request.body as {
      initialBank?: number;
      betAmount?: number;
      cashoutAt?: number;
      minStreak?: number;
      maxBetsPerSession?: number;
      takeProfitPct?: number;
      stopLossPct?: number;
      cooldownRounds?: number;
    } | null;

    const initialBank = Number(body?.initialBank ?? 100);
    if (!Number.isFinite(initialBank) || initialBank <= 0 || initialBank > 100000) {
      return reply.status(400).send({ error: 'initialBank must be 1-100000' });
    }

    try {
      const { configureAutoBet, startAutoBet } = await aviatorTracker();

      // Apply config from request (with safe defaults + bounds)
      const config: Record<string, number | boolean> = {};
      if (body?.betAmount !== undefined) {
        const v = Number(body.betAmount);
        if (!Number.isFinite(v) || v < 0.1 || v > initialBank * 0.5) {
          return reply.status(400).send({ error: 'betAmount must be 0.1 to 50% of bank' });
        }
        config.betAmount = v;
      }
      if (body?.cashoutAt !== undefined) {
        const v = Number(body.cashoutAt);
        if (!Number.isFinite(v) || v < 1.01 || v > 100) {
          return reply.status(400).send({ error: 'cashoutAt must be 1.01-100' });
        }
        config.cashoutAt = v;
      }
      if (body?.minStreak !== undefined) {
        const v = Number(body.minStreak);
        if (!Number.isInteger(v) || v < 0 || v > 10) {
          return reply.status(400).send({ error: 'minStreak must be 0-10' });
        }
        config.minStreak = v;
      }
      if (body?.maxBetsPerSession !== undefined) {
        const v = Number(body.maxBetsPerSession);
        if (!Number.isInteger(v) || v < 1 || v > 500) {
          return reply.status(400).send({ error: 'maxBetsPerSession must be 1-500' });
        }
        config.maxBetsPerSession = v;
      }
      if (body?.takeProfitPct !== undefined) {
        const v = Number(body.takeProfitPct);
        if (!Number.isFinite(v) || v < 1 || v > 1000) {
          return reply.status(400).send({ error: 'takeProfitPct must be 1-1000' });
        }
        config.takeProfitPct = v;
      }
      if (body?.stopLossPct !== undefined) {
        const v = Number(body.stopLossPct);
        if (!Number.isFinite(v) || v < 1 || v > 100) {
          return reply.status(400).send({ error: 'stopLossPct must be 1-100' });
        }
        config.stopLossPct = v;
      }
      if (body?.cooldownRounds !== undefined) {
        const v = Number(body.cooldownRounds);
        if (!Number.isInteger(v) || v < 0 || v > 20) {
          return reply.status(400).send({ error: 'cooldownRounds must be 0-20' });
        }
        config.cooldownRounds = v;
      }
      config.enabled = true;

      configureAutoBet(config as Parameters<typeof configureAutoBet>[0]);
      const state = startAutoBet(initialBank);
      return { success: true, state };
    } catch (err) {
      return reply.status(500).send({ error: `Failed to start auto-bet: ${err}` });
    }
  });

  // POST /predictions/aviator/autobet/stop — stop auto-betting
  app.post('/aviator/autobet/stop', async () => {
    try {
      const { stopAutoBet } = await aviatorTracker();
      const state = stopAutoBet('Manually stopped via API');
      return { success: true, state };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // GET /predictions/aviator/autobet — get current auto-bet state + config
  app.get('/aviator/autobet', async () => {
    try {
      const { getAutoBetState, getAutoBetConfig } = await aviatorTracker();
      return { state: getAutoBetState(), config: getAutoBetConfig() };
    } catch {
      return { state: null, config: null };
    }
  });
};
