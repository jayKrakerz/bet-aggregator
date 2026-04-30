import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';
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
import { getScraperHealth, getScraperHealthSummary } from '../scraper-health.js';
import { getSportsAiData, getSportsAiBotResults, findPredictionForMatch, findValueBetsForMatch, getBotPerformanceSummary } from '../sports-ai-scraper.js';
import { getLivePredictions } from '../live-predictor.js';
import { getDroppingOdds } from '../oddspedia-dropping-odds.js';
import { getEsportsMatches } from '../pinnacle-esports.js';
import { getFlashLiveMatches, toSportyFormat } from '../flashscore-live.js';
import { getSportyLiveGames } from '../sportybet-live.js';
import { getLiveValuePicks } from '../live-value-picks.js';
import { getLateLockPicks } from '../late-lock-scanner.js';
import { getPromoEdges } from '../promo-detector.js';
import { analyzeCashout } from '../cashout-analyzer.js';
import { predictElo, bootstrapEloFromEspn, getEloStats } from '../elo-predictor.js';
import { getEloPicks } from '../elo-picker.js';
// Lazy-loaded to avoid crashing when puppeteer is unavailable (e.g. Vercel)
const liveMonitor = () => import('../live-monitor.js');
const oddsportal = () => import('../oddsportal-scraper.js');
const oddsLagDetector = () => import('../odds-lag-detector.js');
const crossOddsScanner = () => import('../cross-odds-scanner.js');

// Strict alphanumeric pattern for booking codes
const CODE_PATTERN = /^[A-Za-z0-9]{4,8}$/;

// Validate a Sportybet event/market/outcome ID format. Real match IDs are
// numeric. Sport/market/outcome refs use the Betradar `sr:type:id` pattern.
const BETRADAR_ID = /^sr:[a-z]+:[A-Za-z0-9_-]{1,50}$/;
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

// Premium endpoints require a valid X-Unlock-Key header when UNLOCK_KEYS is set.
const UNLOCK_SET = new Set(
  (config.UNLOCK_KEYS ?? '').split(',').map(s => s.trim()).filter(Boolean),
);
function requireUnlock(request: { headers: Record<string, string | string[] | undefined> }, reply: { status: (n: number) => { send: (x: unknown) => unknown } }): boolean {
  if (UNLOCK_SET.size === 0) return true; // no keys configured → open access
  const hdr = request.headers['x-unlock-key'];
  const key = Array.isArray(hdr) ? hdr[0] : hdr;
  if (!key || !UNLOCK_SET.has(key)) {
    void reply.status(402).send({ error: 'premium', message: 'X-Unlock-Key required' });
    return false;
  }
  return true;
}

export const predictionsRoutes: FastifyPluginAsync = async (app) => {

  // GET /predictions/elo?home=<team>&away=<team> — ELO 1X2 prediction
  app.get('/elo', async (request, reply) => {
    const q = request.query as { home?: string; away?: string };
    if (!q.home || !q.away) return reply.status(400).send({ error: 'home and away required' });
    void reply.header('Cache-Control', 'public, max-age=60');
    return predictElo(q.home, q.away);
  });

  // GET /predictions/elo/stats — system health + top-10 ranked teams
  app.get('/elo/stats', async (_request, reply) => {
    void reply.header('Cache-Control', 'public, max-age=120');
    return getEloStats();
  });

  // GET /predictions/elo/picks — pickable selections from ELO across upcoming matches.
  // Query: minEdge, minProbability, maxOdds, minOdds, refresh
  app.get('/elo/picks', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const opts = {
      minEdge: q.minEdge !== undefined ? parseFloat(q.minEdge) : undefined,
      minProbability: q.minProbability !== undefined ? parseFloat(q.minProbability) : undefined,
      maxOdds: q.maxOdds !== undefined ? parseFloat(q.maxOdds) : undefined,
      minOdds: q.minOdds !== undefined ? parseFloat(q.minOdds) : undefined,
    };
    const result = await getEloPicks(opts, q.refresh === '1');
    void reply.header('Cache-Control', 'public, max-age=120');
    return result;
  });

  // POST /predictions/elo/bootstrap — seed ratings from ~180 days of ESPN history.
  // Idempotent: no-op once bootstrappedAt is set.
  app.post('/elo/bootstrap', async (_request, reply) => {
    try {
      const result = await bootstrapEloFromEspn();
      return result;
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // GET /predictions/config — public monetization + affiliate config for frontend
  app.get('/config', async (_request, reply) => {
    void reply.header('Cache-Control', 'public, max-age=300');
    return {
      sportyAffilTag: config.SPORTY_AFFIL_TAG || null,
      buyMeACoffeeUrl: config.BUYMEACOFFEE_URL || null,
      adsenseClientId: config.ADSENSE_CLIENT_ID || null,
      telegramEnabled: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID),
      paywallEnabled: UNLOCK_SET.size > 0,
    };
  });

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
    let createResp: { bizCode?: number; data?: { shareCode?: string }; message?: string } | null = null;
    let shareCode: string | null = null;
    let activeCc: string | null = null;
    let lastErrResp: { bizCode?: number; data?: { shareCode?: string }; message?: string } | null = null;
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
          createResp = data;
          shareCode = data.data.shareCode;
          activeCc = cc;
          break;
        }
        lastErrResp = data;
      } catch {
        if (cc === countries[countries.length - 1] && !lastErrResp) {
          return reply.status(502).send({ error: 'Failed to reach Sportybet API' });
        }
      }
    }
    if (!createResp || !shareCode || !activeCc) {
      return lastErrResp ?? reply.status(502).send({ error: 'All Sportybet endpoints failed' });
    }

    // Authoritative validation: refetch the share code and inspect each leg's
    // isActive flag. Sportybet often issues a share code even when an outcome
    // is currently suspended — the user only sees "suspended" when loading the
    // betslip. This re-fetch hits the same endpoint Sportybet's UI uses, so it
    // reflects the actual betslip state. If any leg is suspended we drop the
    // (already-issued) code and return 409 so the UI can prompt for a refresh.
    try {
      const verifyRes = await fetch(`https://www.sportybet.com/api/${activeCc}/orders/share/${encodeURIComponent(shareCode)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      const verify = await verifyRes.json() as {
        bizCode?: number;
        data?: {
          outcomes?: Array<{
            eventId: string;
            homeTeamName?: string;
            awayTeamName?: string;
            playedSeconds?: string;
            matchStatus?: string;
            markets?: Array<{
              id: string;
              specifier?: string;
              status?: number;
              outcomes?: Array<{ id: string; isActive?: number }>;
            }>;
          }>;
        };
      };
      if (verify.bizCode === 10000 && verify.data?.outcomes) {
        const suspended: Array<{ eventId: string; marketId: string; outcomeId: string; match: string; minute: string | null; reason: string }> = [];
        for (const sel of validated) {
          const ev = verify.data.outcomes.find(o => o.eventId === sel.eventId);
          if (!ev) continue;
          const match = `${ev.homeTeamName ?? ''} v ${ev.awayTeamName ?? ''}`.trim();
          const minute = ev.playedSeconds ? `${ev.playedSeconds.split(':')[0]}'` : (ev.matchStatus ?? null);
          const mkt = ev.markets?.find(m => m.id === sel.marketId && (m.specifier ?? '') === sel.specifier);
          if (!mkt) {
            suspended.push({ eventId: sel.eventId, marketId: sel.marketId, outcomeId: sel.outcomeId, match, minute, reason: 'market not active' });
            continue;
          }
          if (mkt.status !== undefined && mkt.status !== 0) {
            suspended.push({ eventId: sel.eventId, marketId: sel.marketId, outcomeId: sel.outcomeId, match, minute, reason: 'market suspended' });
            continue;
          }
          const out = mkt.outcomes?.find(o => o.id === sel.outcomeId);
          if (!out || out.isActive !== 1) {
            suspended.push({ eventId: sel.eventId, marketId: sel.marketId, outcomeId: sel.outcomeId, match, minute, reason: 'outcome suspended' });
          }
        }
        if (suspended.length > 0) {
          return reply.status(409).send({
            error: 'suspended',
            message: 'Sportybet generated the code but one or more legs are suspended — try a different pick.',
            suspended,
          });
        }
      }
    } catch {
      // Verification failed (network/parse) — fall through and return the code.
      // Better to give the user a code that might work than to block on a flaky check.
    }

    return createResp;
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

  // GET /predictions/games — fetch events with odds from Sportybet (all sports for live)
  app.get('/games', async (request, reply) => {
    const query = request.query as { sportId?: string; timeline?: string; pageSize?: string; pageNum?: string };
    const isLive = query.timeline === 'live';
    const pageSize = Math.min(Math.max(parseInt(query.pageSize || '50', 10) || 50, 1), 100);
    const pageNum = Math.max(parseInt(query.pageNum || '1', 10) || 1, 1);
    const marketId = '1,18,29';
    const ts = Date.now();

    const countries = ['ng', 'gh', 'ke', 'tz', 'zm', 'cm'];
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    // For live: try all sports to find any live action
    // For prematch: use the requested sportId (default football)
    const sportIds = isLive && !query.sportId
      ? ['sr:sport:1', 'sr:sport:2', 'sr:sport:3', 'sr:sport:4', 'sr:sport:5', 'sr:sport:6', 'sr:sport:21', 'sr:sport:22', 'sr:sport:23']
      : [query.sportId || 'sr:sport:1'];

    for (const sid of sportIds) {
      if (!BETRADAR_ID.test(sid)) continue;
      for (const cc of countries) {
        try {
          const group = isLive ? 'Live' : 'Prematch';
          const url = `https://www.sportybet.com/api/${cc}/factsCenter/liveOrPrematchEvents?_t=${ts}&sportId=${encodeURIComponent(sid)}&group=${group}&marketId=${encodeURIComponent(marketId)}&pageSize=${pageSize}&pageNum=${pageNum}`;
          const res = await fetch(url, {
            headers: { 'User-Agent': ua },
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) continue;
          const data = await res.json() as { bizCode?: number; data?: unknown };
          if (data.bizCode === 10000 && data.data) {
            // Normalize: new API returns Tournament[] directly, old returned { tournaments, totalNum }
            let normalized = data.data;
            if (Array.isArray(data.data)) {
              const tournaments = data.data as Array<{ events?: unknown[] }>;
              const totalNum = tournaments.reduce((sum: number, t) => sum + ((t.events as unknown[])?.length || 0), 0);
              normalized = { totalNum, tournaments };
            }
            void reply.header('Cache-Control', 'public, max-age=120');
            return { data: normalized, country: cc, timeline: isLive ? 'live' : 'prematch' };
          }
        } catch {
          // try next country
        }
      }
    }

    // Sportybet live API is geo-restricted — fall back to FlashScore for live data
    if (isLive) {
      try {
        const flashMatches = await getFlashLiveMatches();
        if (flashMatches.length > 0) {
          const data = toSportyFormat(flashMatches);
          void reply.header('Cache-Control', 'public, max-age=60');
          return { data, country: null, timeline: 'live', source: 'flashscore' };
        }
      } catch { /* fall through */ }
    }

    void reply.header('Cache-Control', 'public, max-age=60');
    return { data: { totalNum: 0, tournaments: [] }, country: null, timeline: isLive ? 'live' : 'prematch' };
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

  // GET /predictions/scrapers/health — per-scraper health + aggregate summary
  app.get('/scrapers/health', async (_request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    return {
      summary: getScraperHealthSummary(),
      scrapers: getScraperHealth(),
    };
  });

  // ── Sports-AI.dev Data ───────────────────────────────────

  // GET /predictions/sports-ai — all Sports-AI data (predictions + value bets; bot results excluded for speed)
  app.get('/sports-ai', async (_request, reply) => {
    const data = await getSportsAiData();
    void reply.header('Cache-Control', 'public, max-age=900');
    return {
      predictions: { data: data.predictions, count: data.predictions.length },
      highlights: { data: data.highlights, count: data.highlights.length },
      valueBets: { data: data.valueBets, count: data.valueBets.length },
      fetchedAt: data.fetchedAt,
    };
  });

  // GET /predictions/sports-ai/predictions — AI match predictions with odds
  app.get('/sports-ai/predictions', async (_request, reply) => {
    const data = await getSportsAiData();
    void reply.header('Cache-Control', 'public, max-age=900');
    return { data: data.predictions, highlights: data.highlights, count: data.predictions.length, fetchedAt: data.fetchedAt };
  });

  // GET /predictions/sports-ai/value-bets — value bets with bookmaker comparison
  app.get('/sports-ai/value-bets', async (_request, reply) => {
    const data = await getSportsAiData();
    void reply.header('Cache-Control', 'public, max-age=900');
    return { data: data.valueBets, count: data.valueBets.length, fetchedAt: data.fetchedAt };
  });

  // GET /predictions/sports-ai/bot-results — historical bot performance (loaded on demand, cached 1hr)
  app.get('/sports-ai/bot-results', async (_request, reply) => {
    const results = await getSportsAiBotResults();
    void reply.header('Cache-Control', 'public, max-age=3600');
    return {
      data: results,
      summary: getBotPerformanceSummary(results),
      count: results.length,
    };
  });

  // GET /predictions/sports-ai/match?home=Team&away=Team — lookup AI prediction + value bets for a match
  app.get('/sports-ai/match', async (request, reply) => {
    const { home, away } = request.query as { home?: string; away?: string };
    if (!home || !away) return reply.status(400).send({ error: 'Provide home and away team names' });

    const [prediction, valueBets] = await Promise.all([
      findPredictionForMatch(home, away),
      findValueBetsForMatch(home, away),
    ]);

    return {
      prediction,
      valueBets,
      found: !!prediction || valueBets.length > 0,
    };
  });

  // POST /predictions/sports-ai/score-codes — score booking codes using AI predictions
  app.post('/sports-ai/score-codes', async (request, reply) => {
    const body = request.body as { codes?: Array<{ code: string; selections: Array<{ homeTeam: string; awayTeam: string; pick: string; market: string; odds: number }> }> };
    if (!body?.codes || !Array.isArray(body.codes)) {
      return reply.status(400).send({ error: 'Provide codes array with selections' });
    }

    const scored = await Promise.all(body.codes.slice(0, 20).map(async (code) => {
      let aiAgreements = 0;
      let aiDisagreements = 0;
      let aiMatched = 0;
      const selectionScores: Array<{ homeTeam: string; awayTeam: string; aiPrediction: string | null; aiConfidence: number | null; agrees: boolean | null }> = [];

      for (const sel of code.selections) {
        const pred = await findPredictionForMatch(sel.homeTeam, sel.awayTeam);
        if (!pred || !pred.odds_moneyline.home) {
          selectionScores.push({ homeTeam: sel.homeTeam, awayTeam: sel.awayTeam, aiPrediction: null, aiConfidence: null, agrees: null });
          continue;
        }

        aiMatched++;
        const homePct = pred.implied_home_pct;
        const awayPct = pred.implied_away_pct;
        const drawPct = pred.implied_draw_pct || 0;

        // Determine AI's favored outcome
        let aiFavored: string;
        let aiConfidence: number;
        if (homePct >= awayPct && homePct >= drawPct) {
          aiFavored = 'home';
          aiConfidence = homePct;
        } else if (awayPct >= homePct && awayPct >= drawPct) {
          aiFavored = 'away';
          aiConfidence = awayPct;
        } else {
          aiFavored = 'draw';
          aiConfidence = drawPct;
        }

        // Check if the pick aligns with AI prediction
        const pickLower = sel.pick.toLowerCase();
        const marketLower = sel.market.toLowerCase();
        let agrees: boolean | null = null;

        if (marketLower.includes('1x2') || marketLower.includes('match winner') || marketLower.includes('moneyline')) {
          if (pickLower.includes('home') || pickLower === '1' || pickLower.includes(sel.homeTeam.toLowerCase().slice(0, 4))) {
            agrees = aiFavored === 'home';
          } else if (pickLower.includes('away') || pickLower === '2' || pickLower.includes(sel.awayTeam.toLowerCase().slice(0, 4))) {
            agrees = aiFavored === 'away';
          } else if (pickLower.includes('draw') || pickLower === 'x') {
            agrees = aiFavored === 'draw';
          }
        }

        if (agrees === true) aiAgreements++;
        else if (agrees === false) aiDisagreements++;

        selectionScores.push({
          homeTeam: sel.homeTeam,
          awayTeam: sel.awayTeam,
          aiPrediction: aiFavored,
          aiConfidence: Math.round(aiConfidence * 100) / 100,
          agrees,
        });
      }

      const total = code.selections.length;
      const aiScore = aiMatched > 0
        ? Math.round((aiAgreements / aiMatched) * 100)
        : null;

      return {
        code: code.code,
        aiScore,
        aiMatched,
        aiAgreements,
        aiDisagreements,
        totalSelections: total,
        selections: selectionScores,
      };
    }));

    return { data: scored };
  });

  // ── Live Predictor ───────────────────────────────────────

  // GET /predictions/live-predict — live games with full AI analysis
  // Optional: ?timeline=prematch&limit=10 for testing when no live games
  app.get('/live-predict', async (request, reply) => {
    if (!requireUnlock(request as never, reply as never)) return;
    const query = request.query as { timeline?: string; limit?: string };
    const timeline = query.timeline === 'prematch' ? 'prematch' as const : 'live' as const;
    const limit = Math.min(Math.max(parseInt(query.limit || '50', 10) || 50, 1), 100);

    const result = await getLivePredictions(timeline, limit);
    void reply.header('Cache-Control', `public, max-age=${timeline === 'live' ? 120 : 300}`);
    return result;
  });

  // GET /predictions/cashout — analyze whether to cash out a booking code
  // Params:
  //   code        — booking code
  //   stake       — bet amount (default 100)
  //   originalOdds — acca odds when placed (optional, for post-placement analysis)
  app.get('/cashout', async (request, reply) => {
    const query = request.query as { code?: string; stake?: string; originalOdds?: string };
    if (!query.code || !CODE_PATTERN.test(query.code.toUpperCase())) {
      return reply.status(400).send({ error: 'Invalid or missing code parameter' });
    }
    const stake = Math.max(1, Math.min(1_000_000, parseFloat(query.stake || '100') || 100));
    const originalOdds = query.originalOdds ? parseFloat(query.originalOdds) : undefined;
    const result = await analyzeCashout(query.code.toUpperCase(), stake, originalOdds);
    void reply.header('Cache-Control', 'public, max-age=30');
    return result;
  });

  // GET /predictions/promo-edges — +EV promotional picks (1UP/2UP, low-margin markets)
  app.get('/promo-edges', async (request, reply) => {
    const query = request.query as { minEdge?: string; type?: string; refresh?: string };
    const minEdge = parseFloat(query.minEdge || '0');
    const typeFilter = query.type;
    const forceRefresh = query.refresh === '1';

    const result = await getPromoEdges(forceRefresh);
    let edges = result.edges;
    if (minEdge > 0) edges = edges.filter(e => e.edgePct >= minEdge);
    if (typeFilter) edges = edges.filter(e => e.type === typeFilter);

    void reply.header('Cache-Control', 'public, max-age=60');
    return {
      edges,
      count: edges.length,
      totalCount: result.count,
      byType: result.byType,
      scannedEvents: result.scannedEvents,
      scrapedAt: result.scrapedAt,
    };
  });

  // GET /predictions/live-value-picks — live outcomes with positive Kelly edge
  // from Pinnacle sharp odds + Poisson + tipster consensus + Sports-AI
  app.get('/live-value-picks', async (request, reply) => {
    const query = request.query as { minEdge?: string; minConfidence?: string; refresh?: string };
    const minEdge = parseFloat(query.minEdge || '0');
    const minConfidence = parseInt(query.minConfidence || '0', 10);
    const forceRefresh = query.refresh === '1';

    const result = await getLiveValuePicks(forceRefresh);

    let filtered = result.picks;
    if (minEdge > 0) filtered = filtered.filter(p => p.edge >= minEdge);
    if (minConfidence > 0) filtered = filtered.filter(p => p.confidence >= minConfidence);

    void reply.header('Cache-Control', 'public, max-age=60');
    return {
      picks: filtered,
      count: filtered.length,
      totalCount: result.count,
      highConfidence: result.highConfidence,
      withPinnacle: result.withPinnacle,
      scrapedAt: result.scrapedAt,
      analysisSources: result.analysisSources,
    };
  });

  // GET /predictions/late-locks — positive-EV picks on 85+ minute football matches
  // Targets odd/even, far Under lines, leader double-chance, and tied-match draws —
  // markets where soft-book lag leaves thin but real EV near full-time.
  app.get('/late-locks', async (request, reply) => {
    if (!requireUnlock(request as never, reply as never)) return;
    const query = request.query as { minEv?: string; refresh?: string };
    const minEv = parseFloat(query.minEv || '0');
    const forceRefresh = query.refresh === '1';

    const result = await getLateLockPicks(forceRefresh);
    const filtered = minEv > 0 ? result.picks.filter(p => p.evPct >= minEv) : result.picks;

    void reply.header('Cache-Control', 'public, max-age=30');
    return {
      picks: filtered,
      count: filtered.length,
      totalCount: result.count,
      scanned: result.scanned,
      lateMatches: result.lateMatches,
      scrapedAt: result.scrapedAt,
    };
  });

  // GET /predictions/live-games — all live games across all sports from Sportybet
  // Optional: ?sport=Football&refresh=1
  app.get('/live-games', async (request, reply) => {
    const query = request.query as { sport?: string; refresh?: string };
    const forceRefresh = query.refresh === '1';

    const result = await getSportyLiveGames(forceRefresh);

    // Filter by sport if requested
    if (query.sport) {
      const sportFilter = query.sport.toLowerCase();
      const filtered = result.games.filter(g => g.sport.toLowerCase() === sportFilter);
      void reply.header('Cache-Control', 'public, max-age=60');
      return {
        games: filtered,
        totalCount: filtered.length,
        allSportsCount: result.totalCount,
        bySport: result.bySport,
        scrapedAt: result.scrapedAt,
        source: result.source,
      };
    }

    void reply.header('Cache-Control', 'public, max-age=60');
    return result;
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

  // Kick off ELO bootstrap in the background. Idempotent (no-op if already
  // seeded). Non-blocking so server startup isn't delayed.
  void bootstrapEloFromEspn().catch(err => app.log.warn({ err }, 'ELO bootstrap failed'));

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

  // GET /predictions/sharp-esports — Pinnacle's upcoming CS2 / LoL / Dota /
  // Valorant / FIFAe matches with de-vigged moneyline implied probabilities.
  // Pinnacle is the sharpest market; we surface their lines so the user can
  // line-shop the same match at 22bet or other soft books.
  app.get('/sharp-esports', async (request, reply) => {
    const q = request.query as { game?: string; refresh?: string };
    const result = await getEsportsMatches(q.refresh === '1');
    void reply.header('Cache-Control', 'public, max-age=120');
    if (q.game) {
      const filtered = result.matches.filter((m) => m.game === q.game);
      return { ...result, matches: filtered, totalMatches: filtered.length };
    }
    return result;
  });

  // GET /predictions/dropping-odds — Oddspedia line-movement signals.
  // Query: sport=football|basketball|tennis|all, minDrop=10, period=1hour|6hours|1day|3days
  app.get('/dropping-odds', async (request, reply) => {
    if (!requireUnlock(request as never, reply as never)) return;
    const q = request.query as { sport?: string; minDrop?: string; period?: string };
    const sport = q.sport === 'basketball' || q.sport === 'tennis' || q.sport === 'all' ? q.sport : 'football';
    const minDropPct = q.minDrop ? Math.max(0, Math.min(100, parseFloat(q.minDrop))) : 10;
    const period = q.period === '1hour' || q.period === '6hours' || q.period === '3days' ? q.period : '1day';
    try {
      const result = await getDroppingOdds({ sport, minDropPct, period });
      return result;
    } catch (err) {
      return reply.status(503).send({
        error: 'Oddspedia dropping odds unavailable',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });
};
