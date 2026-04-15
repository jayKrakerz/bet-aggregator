/**
 * Live Game Predictor
 *
 * Fetches live (or upcoming) events from Sportybet, then runs every
 * analysis engine in parallel to produce composite predictions:
 *   - Tipster consensus (6 sites, weighted by track record)
 *   - Poisson statistical model
 *   - Pinnacle sharp odds (value detection)
 *   - Sports-AI ML predictions
 *
 * Result: per-match prediction with best pick, Kelly edge, and confidence.
 */

import { logger } from '../utils/logger.js';
import { scrapeAllTipsters, findMatchingPredictions, buildConsensus } from './tipster-scrapers.js';
import { predictMatch } from './stats-predictor.js';
import { batchPinnacleOdds, type PinnacleOdds } from './pinnacle-odds.js';
import { findPredictionForMatch } from './sports-ai-scraper.js';
import { getSourceWeights } from './consensus-tracker.js';
import { withScraperHealth } from './scraper-health.js';
import { predictLiveState } from './live-state-predictor.js';
import { getDroppingOdds, findDropForMatch, type DroppingOddsResult, type DroppingOddsMatch } from './oddspedia-dropping-odds.js';

// ── Types ────────────────────────────────────────────────────

export interface LiveMatchOdds {
  home: number;
  draw: number;
  away: number;
  over25: number | null;
  under25: number | null;
  bttsYes: number | null;
  bttsNo: number | null;
}

export interface SourcePrediction {
  source: string;
  homePct: number;
  drawPct: number;
  awayPct: number;
  over25Pct: number | null;
  btsPct: number | null;
}

export interface LivePrediction {
  // Match info
  eventId: string;
  home: string;
  away: string;
  league: string;
  sport: string;
  score: string | null;
  minute: string | null;
  matchStatus: string;
  startTime: number;

  // Sportybet odds
  odds: LiveMatchOdds;

  // Composite prediction
  prediction: {
    homePct: number;
    drawPct: number;
    awayPct: number;
    over25Pct: number | null;
    btsPct: number | null;
    bestPick: string;
    bestPickPct: number;
    confidence: number;       // 0-100, based on source agreement
    kellyEdge: Record<string, number>;
    sources: Record<string, SourcePrediction | null>;
    sourceCount: number;
  };

  // Signal
  liveEdge: string | null;
  dropSignal: {
    topDropPct: number;
    sides: Array<{ side: string; dropPct: number; currentOdds: number; peakOdds: number }>;
    supportsBestPick: boolean;
  } | null;
}

export interface LivePredictResult {
  matches: LivePrediction[];
  count: number;
  scrapedAt: string;
  analysisSources: string[];
  timeline: 'live' | 'prematch';
}

// ── Cache ────────────────────────────────────────────────────

let cache: LivePredictResult | null = null;
let cacheTime = 0;
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes for live

// ── Sportybet Event Fetcher ──────────────────────────────────

const COUNTRIES = ['ng', 'gh', 'ke', 'tz', 'zm', 'cm'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// All Sportybet sports
const SPORT_IDS = [
  { id: 'sr:sport:1', name: 'Football', markets: '1,18,29' },
  { id: 'sr:sport:2', name: 'Basketball', markets: '1,18,29' },
  { id: 'sr:sport:3', name: 'Baseball', markets: '1,18' },
  { id: 'sr:sport:4', name: 'Ice Hockey', markets: '1,18,29' },
  { id: 'sr:sport:5', name: 'Tennis', markets: '1,18' },
  { id: 'sr:sport:6', name: 'Handball', markets: '1,18' },
  { id: 'sr:sport:21', name: 'Cricket', markets: '1,18' },
  { id: 'sr:sport:22', name: 'Darts', markets: '1,18' },
  { id: 'sr:sport:23', name: 'Volleyball', markets: '1,18' },
];

interface SportyEvent {
  eventId: string;
  home: string;
  away: string;
  league: string;
  sport: string;
  score: string | null;
  minute: string | null;
  matchStatus: string;
  startTime: number;
  odds: LiveMatchOdds;
}

function parseOdds(markets: Array<Record<string, unknown>>): LiveMatchOdds {
  const result: LiveMatchOdds = {
    home: 0, draw: 0, away: 0,
    over25: null, under25: null,
    bttsYes: null, bttsNo: null,
  };

  for (const mkt of markets) {
    const id = String(mkt.id || '');
    const outcomes = (mkt.outcomes || []) as Array<Record<string, unknown>>;
    const specifier = String(mkt.specifier || '');

    if (id === '1') {
      // 1X2
      for (const o of outcomes) {
        const odds = parseFloat(String(o.odds || '0'));
        if (String(o.id) === '1') result.home = odds;
        else if (String(o.id) === '2') result.draw = odds;
        else if (String(o.id) === '3') result.away = odds;
      }
    } else if (id === '18' && specifier.includes('total=2.5')) {
      // Over/Under 2.5
      for (const o of outcomes) {
        const odds = parseFloat(String(o.odds || '0'));
        if (String(o.id) === '12') result.over25 = odds;
        else if (String(o.id) === '13') result.under25 = odds;
      }
    } else if (id === '29') {
      // GG/NG (Both Teams to Score)
      for (const o of outcomes) {
        const odds = parseFloat(String(o.odds || '0'));
        if (String(o.desc).toLowerCase().includes('yes') || String(o.id) === '74') result.bttsYes = odds;
        else if (String(o.desc).toLowerCase().includes('no') || String(o.id) === '76') result.bttsNo = odds;
      }
    }
  }

  return result;
}

type SportyApiResponse = {
  bizCode?: number;
  data?: {
    totalNum?: number;
    tournaments?: Array<{
      name: string;
      events: Array<{
        eventId: string;
        homeTeamName: string;
        awayTeamName: string;
        estimateStartTime: number;
        matchStatus: string;
        setScore?: string;
        matchClock?: { minute?: number; second?: number; period?: string };
        sport: { name: string; category: { name: string; tournament: { name: string } } };
        markets: Array<Record<string, unknown>>;
      }>;
    }>;
  };
};

function parseSportyEvents(
  data: SportyApiResponse,
  seen: Set<string>,
): SportyEvent[] {
  if (data.bizCode !== 10000 || !data.data?.tournaments) return [];
  const events: SportyEvent[] = [];

  for (const tournament of data.data.tournaments) {
    for (const ev of tournament.events) {
      if (seen.has(ev.eventId)) continue;
      seen.add(ev.eventId);

      const clock = ev.matchClock;
      let minute: string | null = null;
      if (clock?.minute !== undefined) {
        minute = `${clock.minute}'`;
      }

      events.push({
        eventId: ev.eventId,
        home: ev.homeTeamName,
        away: ev.awayTeamName,
        league: `${ev.sport.category.name} - ${ev.sport.category.tournament.name}`,
        sport: ev.sport.name,
        score: ev.setScore || null,
        minute,
        matchStatus: ev.matchStatus || 'Unknown',
        startTime: ev.estimateStartTime,
        odds: parseOdds(ev.markets),
      });
    }
  }

  return events;
}

async function fetchSportPage(
  cc: string, endpoint: string, sportId: string, markets: string, pageNum: number,
): Promise<SportyApiResponse | null> {
  try {
    // Sportybet migrated from pcLiveEvents/pcUpcomingEvents to liveOrPrematchEvents
    const group = endpoint === 'pcLiveEvents' ? 'Live' : 'Prematch';
    const url = `https://www.sportybet.com/api/${cc}/factsCenter/liveOrPrematchEvents?_t=${Date.now()}&sportId=${encodeURIComponent(sportId)}&group=${group}&marketId=${encodeURIComponent(markets)}&pageSize=50&pageNum=${pageNum}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    // New endpoint returns { bizCode, data: Tournament[] } instead of { bizCode, data: { tournaments, totalNum } }
    const raw = await res.json() as { bizCode?: number; data?: unknown };
    if (raw.bizCode !== 10000) return null;
    // Normalize to old shape expected by parseSportyEvents
    if (Array.isArray(raw.data)) {
      const tournaments = raw.data as Array<{ events?: unknown[] }>;
      const totalNum = tournaments.reduce((sum, t) => sum + (t.events?.length || 0), 0);
      return { bizCode: 10000, data: { totalNum, tournaments } } as SportyApiResponse;
    }
    return raw as SportyApiResponse;
  } catch {
    return null;
  }
}

async function fetchSportyEvents(timeline: 'live' | 'prematch', limit: number): Promise<SportyEvent[]> {
  const endpoint = timeline === 'live' ? 'pcLiveEvents' : 'pcUpcomingEvents';
  const allEvents: SportyEvent[] = [];
  const seen = new Set<string>();

  // Fetch page 1 of all sports in parallel (try ng first, fallback others)
  const page1Requests = SPORT_IDS.map(async (sport) => {
    for (const cc of COUNTRIES) {
      const data = await fetchSportPage(cc, endpoint, sport.id, sport.markets, 1);
      if (data?.bizCode === 10000 && data.data?.tournaments?.length) {
        return { sport, cc, data, totalNum: data.data.totalNum || 0 };
      }
    }
    return null;
  });

  const page1Results = await Promise.allSettled(page1Requests);

  // Parse page 1 results + queue extra pages if needed
  const extraPageRequests: Array<{ cc: string; sport: typeof SPORT_IDS[0]; page: number }> = [];

  for (const r of page1Results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const { sport, cc, data, totalNum } = r.value;

    allEvents.push(...parseSportyEvents(data, seen));

    // Queue extra pages if there are more events (max 3 pages per sport)
    const maxPages = Math.min(Math.ceil(totalNum / 50), 3);
    for (let page = 2; page <= maxPages; page++) {
      extraPageRequests.push({ cc, sport, page });
    }
  }

  // Fetch extra pages in parallel (batches of 10)
  if (extraPageRequests.length > 0 && allEvents.length < limit) {
    for (let i = 0; i < extraPageRequests.length; i += 10) {
      const batch = extraPageRequests.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(r => fetchSportPage(r.cc, endpoint, r.sport.id, r.sport.markets, r.page)),
      );
      for (const res of results) {
        if (res.status === 'fulfilled' && res.value) {
          allEvents.push(...parseSportyEvents(res.value, seen));
        }
      }
      if (allEvents.length >= limit) break;
    }
  }

  // Sort by start time, limit
  allEvents.sort((a, b) => a.startTime - b.startTime);
  return allEvents.slice(0, limit);
}

// ── Analysis Engine ──────────────────────────────────────────

function oddsToImplied(odds: number): number {
  return odds > 1 ? Math.round((1 / odds) * 1000) / 10 : 0;
}

function kellyEdge(odds: number, probPct: number): number {
  if (odds <= 1 || probPct <= 0) return 0;
  const p = probPct / 100;
  const edge = (p * odds - 1) / (odds - 1);
  return Math.round(edge * 1000) / 10; // percentage
}

async function analyzeMatch(
  ev: SportyEvent,
  tipsterPredictions: Awaited<ReturnType<typeof scrapeAllTipsters>>,
  pinnacleMap: Map<string, PinnacleOdds>,
  weights: Map<string, number>,
  timeline: 'live' | 'prematch',
  droppingOdds: DroppingOddsResult | null,
): Promise<LivePrediction> {
  // Run analysis sources in parallel
  const [poissonResult, sportsAiResult] = await Promise.allSettled([
    predictMatch(ev.home, ev.away),
    findPredictionForMatch(ev.home, ev.away),
  ]);

  const poisson = poissonResult.status === 'fulfilled' ? poissonResult.value : null;
  const sportsAi = sportsAiResult.status === 'fulfilled' ? sportsAiResult.value : null;

  // Tipster consensus
  const matched = findMatchingPredictions(tipsterPredictions, ev.home, ev.away);
  if (poisson && poisson.confidence >= 25) {
    matched.push({
      source: 'poisson-model',
      homeTeam: ev.home,
      awayTeam: ev.away,
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

  const consensus = buildConsensus(
    matched, ev.home, ev.away,
    {
      home: ev.odds.home,
      draw: ev.odds.draw,
      away: ev.odds.away,
      over25: ev.odds.over25 || undefined,
      under25: ev.odds.under25 || undefined,
    },
    weights,
  );

  // Pinnacle odds
  const pinnacle = pinnacleMap.get(ev.eventId) || null;

  // Build per-source predictions
  const sources: Record<string, SourcePrediction | null> = {};
  let sourceCount = 0;

  if (consensus && consensus.sourceCount > 0) {
    sources['tipsters'] = {
      source: `tipsters (${consensus.sourceCount} sites)`,
      homePct: consensus.homePct,
      drawPct: consensus.drawPct,
      awayPct: consensus.awayPct,
      over25Pct: consensus.over25Pct,
      btsPct: consensus.btsPct,
    };
    sourceCount++;
  } else {
    sources['tipsters'] = null;
  }

  if (poisson && poisson.confidence >= 25) {
    sources['poisson'] = {
      source: `poisson (${poisson.confidence}% conf)`,
      homePct: poisson.homePct,
      drawPct: poisson.drawPct,
      awayPct: poisson.awayPct,
      over25Pct: poisson.over25Pct,
      btsPct: poisson.btsPct,
    };
    sourceCount++;
  } else {
    sources['poisson'] = null;
  }

  if (pinnacle?.moneyline) {
    const ml = pinnacle.moneyline;
    sources['pinnacle'] = {
      source: 'pinnacle (sharp)',
      homePct: oddsToImplied(ml.home),
      drawPct: oddsToImplied(ml.draw),
      awayPct: oddsToImplied(ml.away),
      over25Pct: pinnacle.totals?.[0] ? oddsToImplied(pinnacle.totals[0].over) : null,
      btsPct: null,
    };
    sourceCount++;
  } else {
    sources['pinnacle'] = null;
  }

  if (sportsAi) {
    sources['sportsAi'] = {
      source: 'sports-ai (ML)',
      homePct: sportsAi.implied_home_pct,
      drawPct: sportsAi.implied_draw_pct || 0,
      awayPct: sportsAi.implied_away_pct,
      over25Pct: null,
      btsPct: null,
    };
    sourceCount++;
  } else {
    sources['sportsAi'] = null;
  }

  // In-play state model: only meaningful when match is actually live
  // and we have a parseable score + minute. This is the highest-signal
  // source for live betting because pre-match models have no idea
  // what the current score is.
  sources['liveState'] = null;
  if (timeline === 'live' && ev.score && (ev.minute || ev.matchStatus)) {
    const state = predictLiveState({
      sport: ev.sport,
      score: ev.score,
      minute: ev.minute,
      matchStatus: ev.matchStatus,
    });
    if (state.valid) {
      sources['liveState'] = {
        source: `live-state (${state.reason.split(':')[0]})`,
        homePct: state.homeWinPct,
        drawPct: state.drawPct,
        awayPct: state.awayWinPct,
        over25Pct: state.over25Pct,
        btsPct: state.bttsYesPct,
      };
      sourceCount++;
    }
  }

  // Composite: weighted average of all available sources
  const activeSources = Object.values(sources).filter((s): s is SourcePrediction => s !== null);

  // Weights per source type. Two anchor sources dominate the blend:
  //   - liveState: in-play Poisson driven by current score + minute remaining.
  //     Strictly more informative than any pre-match model once a match is live.
  //   - pinnacle: sharp closing line; long-run unbeatable by public tipsters.
  // Tipsters and ML scrapers can nudge the prior but should not override an anchor.
  const SOURCE_WEIGHTS: Record<string, number> = {
    tipsters: 1.0,
    poisson: 0.8,
    pinnacle: 2.5,
    sportsAi: 0.9,
    liveState: 3.0,
  };

  let homePct = 0, drawPct = 0, awayPct = 0;
  let over25Pct: number | null = null;
  let btsPct: number | null = null;
  let totalWeight = 0;

  if (activeSources.length > 0) {
    const keys = Object.keys(sources);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const src = sources[key];
      if (!src) continue;
      const w = SOURCE_WEIGHTS[key] || 1.0;
      homePct += src.homePct * w;
      drawPct += src.drawPct * w;
      awayPct += src.awayPct * w;
      totalWeight += w;

      if (src.over25Pct !== null) {
        over25Pct = (over25Pct || 0) + src.over25Pct * w;
      }
      if (src.btsPct !== null) {
        btsPct = (btsPct || 0) + src.btsPct * w;
      }
    }

    homePct = Math.round((homePct / totalWeight) * 10) / 10;
    drawPct = Math.round((drawPct / totalWeight) * 10) / 10;
    awayPct = Math.round((awayPct / totalWeight) * 10) / 10;
    if (over25Pct !== null) over25Pct = Math.round((over25Pct / totalWeight) * 10) / 10;
    if (btsPct !== null) btsPct = Math.round((btsPct / totalWeight) * 10) / 10;
  } else {
    // Fallback to Sportybet implied odds
    homePct = oddsToImplied(ev.odds.home);
    drawPct = oddsToImplied(ev.odds.draw);
    awayPct = oddsToImplied(ev.odds.away);
    if (ev.odds.over25) over25Pct = oddsToImplied(ev.odds.over25);
  }

  // Best pick
  const picks: [string, number][] = [
    ['Home', homePct],
    ['Draw', drawPct],
    ['Away', awayPct],
  ];
  if (over25Pct !== null) picks.push(['Over 2.5', over25Pct]);
  if (btsPct !== null && btsPct > 50) picks.push(['BTTS', btsPct]);
  picks.sort((a, b) => b[1] - a[1]);
  const [bestPick, bestPickPct] = picks[0]!;

  // Kelly edges vs Sportybet odds
  const kellyEdges: Record<string, number> = {};
  if (ev.odds.home > 1) kellyEdges['home'] = kellyEdge(ev.odds.home, homePct);
  if (ev.odds.draw > 1) kellyEdges['draw'] = kellyEdge(ev.odds.draw, drawPct);
  if (ev.odds.away > 1) kellyEdges['away'] = kellyEdge(ev.odds.away, awayPct);
  if (ev.odds.over25 && over25Pct !== null) kellyEdges['over25'] = kellyEdge(ev.odds.over25, over25Pct);
  if (ev.odds.under25 && over25Pct !== null) kellyEdges['under25'] = kellyEdge(ev.odds.under25, 100 - over25Pct);

  // Confidence: based on source count + agreement
  let confidence = sourceCount * 20; // 0-80 from sources
  // Agreement bonus: if 3+ sources agree on same best pick
  const sourceBestPicks = activeSources.map(s => {
    const p: [string, number][] = [['Home', s.homePct], ['Draw', s.drawPct], ['Away', s.awayPct]];
    p.sort((a, b) => b[1] - a[1]);
    return p[0]![0];
  });
  const agreeing = sourceBestPicks.filter(p => p === bestPick).length;
  if (agreeing >= 3) confidence += 20;
  else if (agreeing >= 2) confidence += 10;

  // Dropping-odds confirmation: if Oddspedia shows sharp money on the
  // same side as our bestPick, that's an independent market-move signal
  // and worth a confidence bump. If it points the other way, dock it.
  let dropMatch: DroppingOddsMatch | null = null;
  let dropSignalOut: LivePrediction['dropSignal'] = null;
  if (droppingOdds) {
    dropMatch = findDropForMatch(droppingOdds, ev.home, ev.away);
    if (dropMatch) {
      const sides = dropMatch.signals.map(s => ({
        side: s.sideLabel,
        dropPct: s.dropPct,
        currentOdds: s.currentOdds,
        peakOdds: s.peakOdds,
      }));
      const top = dropMatch.signals.reduce((a, b) => (a.dropPct >= b.dropPct ? a : b));
      const topSide = top.side; // 'home' | 'draw' | 'away' | 'over' | ...
      const bestPickKey = bestPick.toLowerCase();
      const supports =
        (topSide === 'home' && bestPickKey === 'home') ||
        (topSide === 'draw' && bestPickKey === 'draw') ||
        (topSide === 'away' && bestPickKey === 'away') ||
        (topSide === 'over' && bestPickKey.startsWith('over')) ||
        (topSide === 'under' && bestPickKey.startsWith('under')) ||
        (topSide === 'btts_yes' && bestPickKey === 'btts');
      if (supports && top.dropPct >= 15) confidence += 10;
      else if (!supports && top.dropPct >= 25) confidence -= 10;
      dropSignalOut = {
        topDropPct: dropMatch.topDropPct,
        sides,
        supportsBestPick: supports,
      };
    }
  }
  confidence = Math.max(0, Math.min(100, confidence));

  // Live edge: only fire when we have an anchor (pinnacle or live-state)
  // and the edge clears 5%. Below that we're inside Pinnacle's own vig
  // spread and the "edge" is just noise.
  let liveEdge: string | null = null;
  const hasAnchor = sources['pinnacle'] !== null || sources['liveState'] !== null;
  if (hasAnchor) {
    const bestEdge = Object.entries(kellyEdges)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])[0];
    if (bestEdge && bestEdge[1] >= 5) {
      const label = bestEdge[0] === 'home' ? ev.home
        : bestEdge[0] === 'away' ? ev.away
        : bestEdge[0] === 'over25' ? 'Over 2.5'
        : bestEdge[0] === 'under25' ? 'Under 2.5'
        : bestEdge[0] === 'draw' ? 'Draw'
        : bestEdge[0];
      liveEdge = `${label} value +${bestEdge[1]}%`;
    }
  }

  return {
    eventId: ev.eventId,
    home: ev.home,
    away: ev.away,
    league: ev.league,
    sport: ev.sport,
    score: ev.score,
    minute: ev.minute,
    matchStatus: ev.matchStatus,
    startTime: ev.startTime,
    odds: ev.odds,
    prediction: {
      homePct,
      drawPct,
      awayPct,
      over25Pct,
      btsPct,
      bestPick,
      bestPickPct,
      confidence,
      kellyEdge: kellyEdges,
      sources,
      sourceCount,
    },
    liveEdge,
    dropSignal: dropSignalOut,
  };
}

// ── Public API ───────────────────────────────────────────────

export async function getLivePredictions(
  timeline: 'live' | 'prematch' = 'live',
  limit = 50,
): Promise<LivePredictResult> {
  // Use cache for live (2 min), longer for prematch (5 min)
  const ttl = timeline === 'live' ? CACHE_TTL : 5 * 60 * 1000;
  if (cache && cache.timeline === timeline && Date.now() - cacheTime < ttl) {
    return cache;
  }

  const result = await withScraperHealth(
    `livePredictor-${timeline}`,
    () => runPredictions(timeline, limit),
    r => r.matches.length,
  );

  cache = result;
  cacheTime = Date.now();
  return result;
}

async function runPredictions(timeline: 'live' | 'prematch', limit: number): Promise<LivePredictResult> {
  // 1. Fetch events from Sportybet
  const events = await fetchSportyEvents(timeline, limit);
  logger.info({ count: events.length, timeline }, 'Live predictor: events fetched');

  if (events.length === 0) {
    return {
      matches: [],
      count: 0,
      scrapedAt: new Date().toISOString(),
      analysisSources: [],
      timeline,
    };
  }

  // 2. Pre-fetch shared data sources in parallel.
  // Dropping odds is best-effort: failures (e.g. no Chrome on host) must
  // not break the predictor, just skip the bonus signal.
  const [tipsterResult, pinnacleResult, weightsResult, droppingResult] = await Promise.allSettled([
    scrapeAllTipsters(),
    batchPinnacleOdds(events.map(ev => ({
      homeTeam: ev.home,
      awayTeam: ev.away,
      league: ev.league,
      eventId: ev.eventId,
    }))),
    Promise.resolve(getSourceWeights()),
    getDroppingOdds({ sport: 'all', minDropPct: 10 }),
  ]);

  const tipsterPredictions = tipsterResult.status === 'fulfilled' ? tipsterResult.value : [];
  const pinnacleMap = pinnacleResult.status === 'fulfilled' ? pinnacleResult.value : new Map<string, PinnacleOdds>();
  const weights = weightsResult.status === 'fulfilled' ? weightsResult.value : new Map<string, number>();
  const droppingOdds = droppingResult.status === 'fulfilled' ? droppingResult.value : null;
  if (droppingResult.status === 'rejected') {
    logger.warn({ err: droppingResult.reason }, 'Oddspedia dropping odds unavailable');
  }

  // 3. Analyze each match (parallel, batches of 10)
  const predictions: LivePrediction[] = [];
  for (let i = 0; i < events.length; i += 10) {
    const batch = events.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(ev => analyzeMatch(ev, tipsterPredictions, pinnacleMap, weights, timeline, droppingOdds)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') predictions.push(r.value);
    }
  }

  // 4. Sort by confidence, then by Kelly edge
  predictions.sort((a, b) => {
    const confDiff = b.prediction.confidence - a.prediction.confidence;
    if (confDiff !== 0) return confDiff;
    const aEdge = Math.max(0, ...Object.values(a.prediction.kellyEdge));
    const bEdge = Math.max(0, ...Object.values(b.prediction.kellyEdge));
    return bEdge - aEdge;
  });

  const activeSources: string[] = [];
  if (tipsterPredictions.length > 0) activeSources.push('tipsters');
  if (pinnacleMap.size > 0) activeSources.push('pinnacle');
  activeSources.push('poisson', 'sportsAi');
  if (timeline === 'live') activeSources.push('liveState');
  if (droppingOdds && droppingOdds.matches.length > 0) activeSources.push('oddspedia-drop');

  logger.info({
    matches: predictions.length,
    withEdge: predictions.filter(p => p.liveEdge).length,
    avgConfidence: predictions.length > 0
      ? Math.round(predictions.reduce((s, p) => s + p.prediction.confidence, 0) / predictions.length)
      : 0,
    timeline,
  }, 'Live predictor: analysis complete');

  return {
    matches: predictions,
    count: predictions.length,
    scrapedAt: new Date().toISOString(),
    analysisSources: activeSources,
    timeline,
  };
}
