/**
 * Tipster Prediction Scrapers
 *
 * Ported from AI-SportyBet-Bot-Phone-main (Python/BeautifulSoup).
 *
 * Scrapes predicted probabilities for football matches from 6 independent
 * tipster sites, then aggregates them into a consensus view with Kelly edge.
 *
 * Sources:
 *   1. Statarea     — 1X2, O/U 2.5, BTS probabilities
 *   2. BetClan      — voted probability distributions
 *   3. FootballSuperTips — 1X2, O/U, BTS predictions
 *   4. Forebet      — 1X2, O/U, BTS probabilities (JS-rendered)
 *   5. AccumulatorTips — aggregated predictions with confidence %
 *   6. PremaTips    — 1X2, O/U, BTS predictions
 */

import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────────

export interface TipsterPrediction {
  source: string;
  homeTeam: string;
  awayTeam: string;
  date: string;
  time: string;
  homePct: number;
  drawPct: number;
  awayPct: number;
  over25Pct: number | null;
  under25Pct: number | null;
  btsPct: number | null;
  otsPct: number | null;
}

export interface ConsensusPrediction {
  homeTeam: string;
  awayTeam: string;
  sources: string[];
  sourceCount: number;
  homePct: number;
  drawPct: number;
  awayPct: number;
  over25Pct: number | null;
  under25Pct: number | null;
  btsPct: number | null;
  otsPct: number | null;
  bestPick: string;
  bestPickPct: number;
  kellyEdge: Record<string, number> | null;
}

// ── Shared fetch with UA + timeout ──────────────────────────

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchHtml(url: string, timeoutMs = 15000): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseNum(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s.replace('%', '').trim());
  return isNaN(n) ? 0 : n;
}

// ── 1. Statarea ─────────────────────────────────────────────

async function scrapeStatarea(): Promise<TipsterPrediction[]> {
  const date = todayStr();
  const url = `https://www.statarea.com/predictions/date/${date}/competition`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const results: TipsterPrediction[] = [];

  $('div.match').each((_, el) => {
    const dateStr = date;
    const time = $(el).find('div.date').text().trim();
    const home = $(el).find('div.hostteam div.name').text().trim();
    const away = $(el).find('div.guestteam div.name').text().trim();
    if (!home || !away) return;

    const values: string[] = [];
    $(el)
      .find('div.inforow div.coefrow div.coefbox div.value')
      .each((_, v) => { values.push($(v).text().trim()); });

    if (values.length < 11) return;

    results.push({
      source: 'statarea',
      homeTeam: home,
      awayTeam: away,
      date: dateStr,
      time,
      homePct: parseNum(values[0]),
      drawPct: parseNum(values[1]),
      awayPct: parseNum(values[2]),
      over25Pct: parseNum(values[7]),
      under25Pct: 100 - parseNum(values[7]),
      btsPct: parseNum(values[9]),
      otsPct: parseNum(values[10]),
    });
  });

  return results;
}

// ── 2. BetClan ──────────────────────────────────────────────

async function scrapeBetclan(): Promise<TipsterPrediction[]> {
  const indexUrl = 'https://www.betclan.com/todays-football-predictions/';
  const indexHtml = await fetchHtml(indexUrl);
  const $index = cheerio.load(indexHtml);

  // Collect unique detail links
  const links: string[] = [];
  $index('a').each((_, el) => {
    const href = $index(el).attr('href');
    if (
      href?.startsWith('https://www.betclan.com/predictionsdetails/') &&
      !links.includes(href)
    ) {
      links.push(href);
    }
  });

  // Limit to avoid hammering the site
  const results: TipsterPrediction[] = [];
  const batch = links.slice(0, 80);

  for (const link of batch) {
    try {
      const html = await fetchHtml(link, 10000);
      const $ = cheerio.load(html);

      const dateTime = $('span.dategamedetailsis').text().trim().split(/\s+/);
      const teamsText = $('div.teamstop').text().trim().split('\n');
      const home = teamsText[0]?.trim();
      const away = teamsText[teamsText.length - 1]?.trim();
      if (!home || !away) continue;

      // Vote stats: each div has pairs like "45% 25% 30%"
      const preds: number[][] = [];
      $('div.cell.vote__stats.js-vote-stats-container').each((_, el) => {
        const nums = $(el)
          .text()
          .replace(/%/g, '')
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((n) => !isNaN(n));
        preds.push(nums);
      });

      if (preds.length < 3 || preds[0]!.length < 6) continue;

      results.push({
        source: 'betclan',
        homeTeam: home,
        awayTeam: away,
        date: dateTime[1] || todayStr(),
        time: dateTime[2] || '',
        homePct: preds[0]![1]!,
        drawPct: preds[0]![3]!,
        awayPct: preds[0]![5]!,
        under25Pct: preds[1]?.[1] ?? null,
        over25Pct: preds[1]?.[3] ?? null,
        btsPct: preds[2]?.[1] ?? null,
        otsPct: preds[2]?.[3] ?? null,
      });
    } catch {
      // skip failed individual pages
    }
  }

  return results;
}

// ── 3. FootballSuperTips ────────────────────────────────────

async function scrapeFootballSuperTips(): Promise<TipsterPrediction[]> {
  const urls = {
    '1x2': 'https://www.footballsuper.tips/todays-free-football-super-tips/',
    'ou': 'https://www.footballsuper.tips/todays-over-under-football-super-tips/',
    'bts': 'https://www.footballsuper.tips/todays-both-teams-to-score-football-super-tips/',
  };

  // 1X2 data
  const html1x2 = await fetchHtml(urls['1x2']);
  const $1 = cheerio.load(html1x2);

  const matches1x2: {
    date: string;
    time: string;
    home: string;
    away: string;
    homePct: number;
    drawPct: number;
    awayPct: number;
  }[] = [];

  const dates = $1('div.datedisp').map((_, el) => $1(el).text().split(/\s+/)[0] || '').get();
  const times = $1('div.datedisp').map((_, el) => $1(el).text().split(/\s+/)[1] || '').get();
  const homes = $1('div.homedisp').map((_, el) => $1(el).text().trim()).get();
  const aways = $1('div.awaydisp').map((_, el) => $1(el).text().trim()).get();
  const percs: number[][] = [];
  $1('div.percdiv').each((_, el) => {
    percs.push($1(el).text().replace(/%/g, '').trim().split(/\s+/).map(Number));
  });

  for (let i = 0; i < homes.length; i++) {
    const p = percs[i];
    if (!p || p.length < 3) continue;
    matches1x2.push({
      date: dates[i] || todayStr(),
      time: times[i] || '',
      home: homes[i]!,
      away: aways[i]!,
      homePct: p[0]!,
      drawPct: p[1]!,
      awayPct: p[2]!,
    });
  }

  // Over/Under data
  const htmlOu = await fetchHtml(urls['ou']);
  const $2 = cheerio.load(htmlOu);
  const ouMap = new Map<string, { over: number; under: number }>();
  const ouHomes = $2('div.homedisp').map((_, el) => $2(el).text().trim()).get();
  const ouAways = $2('div.awaydisp').map((_, el) => $2(el).text().trim()).get();
  const ouPercs: number[][] = [];
  $2('div.percdiv').each((_, el) => {
    ouPercs.push($2(el).text().replace(/%/g, '').trim().split(/\s+/).map(Number));
  });
  for (let i = 0; i < ouHomes.length; i++) {
    const p = ouPercs[i];
    if (!p || p.length < 2) continue;
    ouMap.set(`${ouHomes[i]}|${ouAways[i]}`, { over: p[0]!, under: p[1]! });
  }

  // BTS data
  const htmlBts = await fetchHtml(urls['bts']);
  const $3 = cheerio.load(htmlBts);
  const btsMap = new Map<string, { bts: number; ots: number }>();
  const btsHomes = $3('div.homedisp').map((_, el) => $3(el).text().trim()).get();
  const btsAways = $3('div.awaydisp').map((_, el) => $3(el).text().trim()).get();
  const btsPercs: number[][] = [];
  $3('div.percdiv').each((_, el) => {
    btsPercs.push($3(el).text().replace(/%/g, '').trim().split(/\s+/).map(Number));
  });
  for (let i = 0; i < btsHomes.length; i++) {
    const p = btsPercs[i];
    if (!p || p.length < 2) continue;
    btsMap.set(`${btsHomes[i]}|${btsAways[i]}`, { bts: p[0]!, ots: p[1]! });
  }

  // Merge
  const results: TipsterPrediction[] = [];
  for (const m of matches1x2) {
    const key = `${m.home}|${m.away}`;
    const ou = ouMap.get(key);
    const bts = btsMap.get(key);
    results.push({
      source: 'footballsupertips',
      homeTeam: m.home,
      awayTeam: m.away,
      date: m.date,
      time: m.time,
      homePct: m.homePct,
      drawPct: m.drawPct,
      awayPct: m.awayPct,
      over25Pct: ou?.over ?? null,
      under25Pct: ou?.under ?? null,
      btsPct: bts?.bts ?? null,
      otsPct: bts?.ots ?? null,
    });
  }

  return results;
}

// ── 4. Forebet (static HTML — no JS rendering needed for basic data) ──

async function scrapeForebet(): Promise<TipsterPrediction[]> {
  const date = todayStr();
  const url = `https://www.forebet.com/en/football-predictions/predictions-1x2/${date}`;

  let html: string;
  try {
    html = await fetchHtml(url);
  } catch {
    return [];
  }
  const $ = cheerio.load(html);
  const schema = $('div.schema');
  if (!schema.length) return [];

  const results: TipsterPrediction[] = [];

  const matchDates = schema.find('span.date_bah').map((_, el) => $(el).text().split(/\s+/)[0] || '').get();
  const matchTimes = schema.find('span.date_bah').map((_, el) => $(el).text().split(/\s+/).pop() || '').get();
  const homeTeams = schema.find('span.homeTeam').map((_, el) => $(el).text().trim()).get();
  const awayTeams = schema.find('span.awayTeam').map((_, el) => $(el).text().trim()).get();

  const probDivs = schema.find('div.fprc');
  const homePcts: number[] = [];
  const drawPcts: number[] = [];
  const awayPcts: number[] = [];

  probDivs.each((_, el) => {
    const spans = $(el).find('span');
    homePcts.push(parseNum(spans.eq(0).text()));
    drawPcts.push(parseNum(spans.eq(1).text()));
    awayPcts.push(parseNum(spans.eq(2).text()));
  });

  for (let i = 0; i < homeTeams.length; i++) {
    if (!homeTeams[i] || !awayTeams[i]) continue;
    if (i >= homePcts.length) break;
    results.push({
      source: 'forebet',
      homeTeam: homeTeams[i]!,
      awayTeam: awayTeams[i]!,
      date: matchDates[i] || date,
      time: matchTimes[i] || '',
      homePct: homePcts[i]!,
      drawPct: drawPcts[i]!,
      awayPct: awayPcts[i]!,
      over25Pct: null,
      under25Pct: null,
      btsPct: null,
      otsPct: null,
    });
  }

  return results;
}

// ── 5. PremaTips ────────────────────────────────────────────

async function scrapePrematips(): Promise<TipsterPrediction[]> {
  const date = todayStr();
  const urls = {
    '1x2': `https://primatips.com/tips/${date}`,
    'ou': `https://primatips.com/tips/${date}/over-under-25`,
    'bts': `https://primatips.com/tips/${date}/both-teams-to-score`,
  };

  // 1X2
  let html: string;
  try {
    html = await fetchHtml(urls['1x2']);
  } catch {
    return [];
  }
  const $1 = cheerio.load(html);

  const times1x2 = $1('span.tm').map((_, el) => $1(el).text().trim()).get();
  const names = $1('span.nms').map((_, el) => $1(el).text().trim()).get();
  const homes1x2 = names.map((n) => n.split('-')[0]?.trim() || '');
  const aways1x2 = names.map((n) => n.split('-').pop()?.trim() || '');

  const perVals = $1('span.t').map((_, el) => $1(el).text().trim()).get();
  const homePcts = perVals.filter((_, i) => i % 3 === 0).map(parseNum);
  const drawPcts = perVals.filter((_, i) => i % 3 === 1).map(parseNum);
  const awayPcts = perVals.filter((_, i) => i % 3 === 2).map(parseNum);

  // O/U
  const ouMap = new Map<string, { over: number; under: number }>();
  try {
    const htmlOu = await fetchHtml(urls['ou']);
    const $2 = cheerio.load(htmlOu);
    const ouNames = $2('span.nms').map((_, el) => $2(el).text().trim()).get();
    const ouVals = $2('span.t2').map((_, el) => $2(el).text().trim()).get();
    for (let i = 0; i < ouNames.length; i++) {
      const over = parseNum(ouVals[i * 2]);
      const under = parseNum(ouVals[i * 2 + 1]);
      ouMap.set(ouNames[i]!, { over, under });
    }
  } catch { /* optional */ }

  // BTS
  const btsMap = new Map<string, { bts: number; ots: number }>();
  try {
    const htmlBts = await fetchHtml(urls['bts']);
    const $3 = cheerio.load(htmlBts);
    const btsNames = $3('span.nms').map((_, el) => $3(el).text().trim()).get();
    const btsVals = $3('span.t2').map((_, el) => $3(el).text().trim()).get();
    for (let i = 0; i < btsNames.length; i++) {
      const bts = parseNum(btsVals[i * 2]);
      const ots = parseNum(btsVals[i * 2 + 1]);
      btsMap.set(btsNames[i]!, { bts, ots });
    }
  } catch { /* optional */ }

  const results: TipsterPrediction[] = [];
  for (let i = 0; i < homes1x2.length; i++) {
    if (!homes1x2[i] || !aways1x2[i]) continue;
    if (i >= homePcts.length) break;
    const nameKey = names[i]!;
    const ou = ouMap.get(nameKey);
    const bts = btsMap.get(nameKey);
    results.push({
      source: 'prematips',
      homeTeam: homes1x2[i]!,
      awayTeam: aways1x2[i]!,
      date,
      time: times1x2[i] || '',
      homePct: homePcts[i]!,
      drawPct: drawPcts[i]!,
      awayPct: awayPcts[i]!,
      over25Pct: ou?.over ?? null,
      under25Pct: ou?.under ?? null,
      btsPct: bts?.bts ?? null,
      otsPct: bts?.ots ?? null,
    });
  }

  return results;
}

// ── 6. AccumulatorTips ──────────────────────────────────────
// Note: This scraper requires visiting many sub-pages and parsing complex
// JS-rendered content. We do a simplified static scrape of the index page.

async function scrapeAccumulator(): Promise<TipsterPrediction[]> {
  const indexUrl = 'https://www.accagenerator.com/football-predictions/';
  let indexHtml: string;
  try {
    indexHtml = await fetchHtml(indexUrl);
  } catch {
    return [];
  }

  const $index = cheerio.load(indexHtml);
  const links: string[] = [];
  $index('a').each((_, el) => {
    const href = $index(el).attr('href');
    if (
      href?.startsWith(
        'https://www.accagenerator.com/football-tips-and-predictions-for',
      ) &&
      !links.includes(href)
    ) {
      links.push(href);
    }
  });

  const results: TipsterPrediction[] = [];
  // Limit to prevent hammering; only check 1x2 sub-pages
  const batch = links.slice(0, 40);

  for (const link of batch) {
    try {
      const html = await fetchHtml(link + '1x2-predictions/', 10000);
      const $ = cheerio.load(html);

      // Each match is in an li inside the predictions list
      $('ul li').each((_, li) => {
        const $li = $(li);
        const teamsEl = $li.find('h3.tips-card__name-first');
        if (!teamsEl.length) return;

        const teamText = teamsEl.text();
        const teams = teamText.split('vs').map((t) => t.trim());
        if (teams.length < 2) return;

        const dateText = $li.find('div.datecombos').text().trim().split(/\s+/);
        const time = dateText[3] || '';

        const tip = $li.find('div.tipdetail').text().trim();
        const tipPerEl = $li.find('span.count-text');
        const tipPer = parseNum(tipPerEl.attr('data-stop') || tipPerEl.text());

        if (!tipPer) return;

        let homePct = 33,
          drawPct = 33,
          awayPct = 34;
        if (tip === '1') {
          homePct = tipPer;
          drawPct = Math.round((100 - tipPer) / 2);
          awayPct = 100 - tipPer - drawPct;
        } else if (tip === '2') {
          awayPct = tipPer;
          drawPct = Math.round((100 - tipPer) / 2);
          homePct = 100 - tipPer - drawPct;
        } else if (tip === 'X') {
          drawPct = tipPer;
          homePct = Math.round((100 - tipPer) / 2);
          awayPct = 100 - tipPer - homePct;
        }

        results.push({
          source: 'accumulator',
          homeTeam: teams[0]!,
          awayTeam: teams[1]!,
          date: todayStr(),
          time,
          homePct,
          drawPct,
          awayPct,
          over25Pct: null,
          under25Pct: null,
          btsPct: null,
          otsPct: null,
        });
      });
    } catch {
      // skip failed pages
    }
  }

  return results;
}

// ── Scrape All Sources ──────────────────────────────────────

const scraperFns: Array<{
  name: string;
  fn: () => Promise<TipsterPrediction[]>;
}> = [
  { name: 'statarea', fn: scrapeStatarea },
  { name: 'betclan', fn: scrapeBetclan },
  { name: 'footballsupertips', fn: scrapeFootballSuperTips },
  { name: 'forebet', fn: scrapeForebet },
  { name: 'prematips', fn: scrapePrematips },
  { name: 'accumulator', fn: scrapeAccumulator },
];

/** In-memory cache of all predictions */
let allPredictions: TipsterPrediction[] = [];
let lastScrapeTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 min

/**
 * Scrape all tipster sources in parallel.
 * Returns flat array of all predictions.
 */
export async function scrapeAllTipsters(): Promise<TipsterPrediction[]> {
  if (allPredictions.length > 0 && Date.now() - lastScrapeTime < CACHE_TTL) {
    return allPredictions;
  }

  const results = await Promise.allSettled(
    scraperFns.map(async ({ name, fn }) => {
      try {
        const preds = await fn();
        logger.info({ source: name, count: preds.length }, 'Tipster scraped');
        return preds;
      } catch (err) {
        logger.warn({ source: name, err }, 'Tipster scrape failed');
        return [] as TipsterPrediction[];
      }
    }),
  );

  allPredictions = results.flatMap((r) =>
    r.status === 'fulfilled' ? r.value : [],
  );
  lastScrapeTime = Date.now();
  return allPredictions;
}

// ── Fuzzy Matching ──────────────────────────────────────────

/**
 * Simple sequence similarity ratio (port of Python difflib.SequenceMatcher).
 * Returns 0-1 ratio of how similar two strings are.
 */
function similarity(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 1;

  const longer = al.length >= bl.length ? al : bl;
  const shorter = al.length < bl.length ? al : bl;
  if (longer.length === 0) return 1;

  // LCS-based similarity
  let matches = 0;
  const longerUsed = new Array(longer.length).fill(false);
  for (let i = 0; i < shorter.length; i++) {
    for (let j = 0; j < longer.length; j++) {
      if (!longerUsed[j] && shorter[i] === longer[j]) {
        matches++;
        longerUsed[j] = true;
        break;
      }
    }
  }

  return (2 * matches) / (al.length + bl.length);
}

const MATCH_THRESHOLD = 0.55;

/**
 * Find all predictions matching a given home/away team pair
 * using fuzzy name matching at 55% threshold (same as the Python bot).
 */
export function findMatchingPredictions(
  predictions: TipsterPrediction[],
  homeTeam: string,
  awayTeam: string,
): TipsterPrediction[] {
  return predictions.filter((p) => {
    const homeSim = similarity(p.homeTeam, homeTeam);
    const awaySim = similarity(p.awayTeam, awayTeam);
    return homeSim >= MATCH_THRESHOLD && awaySim >= MATCH_THRESHOLD;
  });
}

// ── Kelly Criterion ─────────────────────────────────────────

/**
 * Calculate Kelly edge for a given odd and predicted probability.
 *
 * Kelly % = ((odds * p) - q) / odds
 * where p = probability, q = 1 - p, odds = decimal odds - 1
 *
 * Returns the fractional edge (e.g., 0.05 = 5% edge).
 */
export function kellyEdge(decimalOdds: number, probabilityPct: number): number {
  const odds = decimalOdds - 1;
  if (odds <= 0) return 0;
  const p = probabilityPct / 100;
  const q = 1 - p;
  return (odds * p - q) / odds;
}

// ── Consensus Builder ───────────────────────────────────────

/**
 * Build consensus prediction for a match by averaging predictions
 * from all matching sources. Optionally compute Kelly edge if
 * SportyBet odds are provided.
 */
export function buildConsensus(
  matched: TipsterPrediction[],
  homeTeam: string,
  awayTeam: string,
  odds?: { home?: number; draw?: number; away?: number; over25?: number; under25?: number },
): ConsensusPrediction | null {
  if (matched.length === 0) return null;

  // Deduplicate by source (keep first per source)
  const seen = new Set<string>();
  const unique = matched.filter((p) => {
    if (seen.has(p.source)) return false;
    seen.add(p.source);
    return true;
  });

  const avg = (vals: number[]) =>
    vals.length > 0
      ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
      : 0;
  const avgOrNull = (vals: (number | null)[]) => {
    const nums = vals.filter((v): v is number => v !== null);
    return nums.length > 0 ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
  };

  const homePct = avg(unique.map((p) => p.homePct));
  const drawPct = avg(unique.map((p) => p.drawPct));
  const awayPct = avg(unique.map((p) => p.awayPct));
  const over25Pct = avgOrNull(unique.map((p) => p.over25Pct));
  const under25Pct = avgOrNull(unique.map((p) => p.under25Pct));
  const btsPct = avgOrNull(unique.map((p) => p.btsPct));
  const otsPct = avgOrNull(unique.map((p) => p.otsPct));

  // Best pick
  const picks: [string, number][] = [
    ['Home', homePct],
    ['Draw', drawPct],
    ['Away', awayPct],
  ];
  if (over25Pct !== null) picks.push(['Over 2.5', over25Pct]);
  if (btsPct !== null) picks.push(['BTS', btsPct]);
  picks.sort((a, b) => b[1] - a[1]);
  const [bestPick, bestPickPct] = picks[0]!;

  // Kelly edges if odds provided
  let kellyEdges: Record<string, number> | null = null;
  if (odds) {
    kellyEdges = {};
    if (odds.home) kellyEdges['home'] = kellyEdge(odds.home, homePct);
    if (odds.draw) kellyEdges['draw'] = kellyEdge(odds.draw, drawPct);
    if (odds.away) kellyEdges['away'] = kellyEdge(odds.away, awayPct);
    if (odds.over25 && over25Pct !== null)
      kellyEdges['over25'] = kellyEdge(odds.over25, over25Pct);
    if (odds.under25 && under25Pct !== null)
      kellyEdges['under25'] = kellyEdge(odds.under25, under25Pct);
  }

  return {
    homeTeam,
    awayTeam,
    sources: unique.map((p) => p.source),
    sourceCount: unique.length,
    homePct,
    drawPct,
    awayPct,
    over25Pct,
    under25Pct,
    btsPct,
    otsPct,
    bestPick,
    bestPickPct,
    kellyEdge: kellyEdges,
  };
}
