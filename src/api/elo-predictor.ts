/**
 * ELO Rating Predictor — self-learning team strength model.
 *
 * Independent of the Poisson goal model. Produces 1X2 probabilities purely
 * from a team's rating relative to its opponent's, plus a fixed home
 * advantage.
 *
 * How it works:
 *   - Every team starts at 1500 when first seen.
 *   - After a match settles, both teams' ratings update by K × (actual −
 *     expected). Winners gain, losers lose.
 *   - Draws are a split update (0.5 expected each).
 *   - Home advantage: we add +HOME_BONUS to the home team's effective
 *     rating when computing expected score, then strip it back out for
 *     the update itself.
 *   - Derived draw probability: ELO natively outputs only two-way odds,
 *     so we adapt Davidson's draw model — P(draw) peaks when teams are
 *     evenly matched and shrinks with rating gap.
 *
 * State is persisted to data/elo_ratings.json. On first start we
 * bootstrap ratings from ~180 days of ESPN scores so the model is useful
 * from day 1 instead of all-1500 neutral.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

// ── Tunables ─────────────────────────────────────────────

const INITIAL = 1500;
const K_FACTOR = 24;          // how much a single match moves a rating
const HOME_BONUS = 65;        // pts added to home team when computing P(win)
const DRAW_SHAPE = 230;       // higher → flatter draw prob curve
const SCALE = 400;             // standard ELO scale factor
const MAX_TEAMS_RETAINED = 20000;
const BOOTSTRAP_DAYS = 180;    // how far back to seed from ESPN on cold start

const ESPN_BASE = 'https://site.api.espn.com/apis';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ESPN_LEAGUES = [
  'eng.1', 'eng.2', 'esp.1', 'ger.1', 'ita.1', 'fra.1',
  'uefa.champions', 'uefa.europa', 'usa.1', 'ned.1', 'por.1',
  'bra.1', 'arg.1', 'tur.1', 'sco.1', 'bel.1', 'gre.1',
];

// ── Types ────────────────────────────────────────────────

export interface EloPrediction {
  home: string;
  away: string;
  homeRating: number;
  awayRating: number;
  homeWinPct: number;  // 0-100
  drawPct: number;
  awayWinPct: number;
  matchesSeen: number; // combined history for both teams
  confident: boolean;  // true when both teams have at least CONFIDENT_N matches
}

interface TeamRating {
  rating: number;
  matches: number;
  lastUpdated: string; // ISO
}

interface PersistedEloState {
  version: number;
  bootstrappedAt: string | null;
  teams: Array<[string, TeamRating]>;
}

// ── Persistence ──────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'elo_ratings.json');

function loadState(): { teams: Map<string, TeamRating>; bootstrappedAt: string | null } {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as PersistedEloState;
      return {
        teams: new Map(Array.isArray(raw.teams) ? raw.teams : []),
        bootstrappedAt: raw.bootstrappedAt ?? null,
      };
    }
  } catch (err) {
    logger.warn({ err }, 'Could not load ELO state; starting fresh');
  }
  return { teams: new Map(), bootstrappedAt: null };
}

function saveState(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Trim oldest-seen-first if we blow past the retention cap.
    if (teams.size > MAX_TEAMS_RETAINED) {
      const sorted = [...teams.entries()].sort(
        (a, b) => new Date(a[1].lastUpdated).getTime() - new Date(b[1].lastUpdated).getTime(),
      );
      const drop = sorted.slice(0, teams.size - MAX_TEAMS_RETAINED);
      for (const [name] of drop) teams.delete(name);
    }
    const state: PersistedEloState = {
      version: 1,
      bootstrappedAt,
      teams: [...teams.entries()],
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (err) {
    logger.warn({ err }, 'Could not persist ELO state');
  }
}

const _loaded = loadState();
const teams = _loaded.teams;
let bootstrappedAt: string | null = _loaded.bootstrappedAt;

// ── Name normalization (shared lightweight form) ─────────

function normName(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*(fc|sc|cf|afc|ac|ud|cd|rc|rcd|cp|sv|bsc|tsv)\s*/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Core math ────────────────────────────────────────────

function getOrInit(name: string): TeamRating {
  const key = normName(name);
  let t = teams.get(key);
  if (!t) {
    t = { rating: INITIAL, matches: 0, lastUpdated: new Date().toISOString() };
    teams.set(key, t);
  }
  return t;
}

function expectedScore(raHome: number, raAway: number): number {
  return 1 / (1 + Math.pow(10, (raAway - (raHome + HOME_BONUS)) / SCALE));
}

/**
 * Davidson-style draw-aware three-way probability.
 * Given ELO-derived two-way expected score eH, we carve out P(draw) using
 * a Gaussian-ish peak centered on rating parity.
 */
function threeWayProbs(raHome: number, raAway: number): { home: number; draw: number; away: number } {
  const diff = (raHome + HOME_BONUS) - raAway;
  // Draw peaks when diff=0 and decays with |diff|.
  const pDrawRaw = Math.exp(-(diff * diff) / (2 * DRAW_SHAPE * DRAW_SHAPE));
  // Two-way expected score (ignores draw).
  const eHome = 1 / (1 + Math.pow(10, -diff / SCALE));
  // Apportion remaining probability (1 - pDraw) between home/away.
  const pDraw = Math.min(0.32, Math.max(0.18, pDrawRaw * 0.30)); // 18–32% band
  const pHome = (1 - pDraw) * eHome;
  const pAway = (1 - pDraw) * (1 - eHome);
  return { home: pHome, draw: pDraw, away: pAway };
}

// ── Public: predict ──────────────────────────────────────

export function predictElo(home: string, away: string): EloPrediction {
  const h = getOrInit(home);
  const a = getOrInit(away);
  const { home: pH, draw: pD, away: pA } = threeWayProbs(h.rating, a.rating);
  return {
    home,
    away,
    homeRating: Math.round(h.rating),
    awayRating: Math.round(a.rating),
    homeWinPct: Math.round(pH * 1000) / 10,
    drawPct: Math.round(pD * 1000) / 10,
    awayWinPct: Math.round(pA * 1000) / 10,
    matchesSeen: h.matches + a.matches,
    confident: h.matches >= 5 && a.matches >= 5,
  };
}

// ── Public: update on a settled match ────────────────────

export function updateFromResult(home: string, away: string, homeGoals: number, awayGoals: number): void {
  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return;
  const h = getOrInit(home);
  const a = getOrInit(away);

  // Actual score in the [0,1] K-update scale — 1 win, 0.5 draw, 0 loss.
  const actualHome = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;
  const actualAway = 1 - actualHome;

  // Expected score INCLUDES home bonus (the bonus is real — the home team
  // was favored going in). But the rating UPDATE uses the full K-weighted
  // delta either way.
  const eHome = expectedScore(h.rating, a.rating);
  const eAway = 1 - eHome;

  // Margin-of-victory multiplier — routs update more than 1-0 grinds.
  const diff = Math.abs(homeGoals - awayGoals);
  const movMult = diff <= 1 ? 1.0 : diff === 2 ? 1.25 : Math.log(diff + 1) + 0.5;

  h.rating += K_FACTOR * movMult * (actualHome - eHome);
  a.rating += K_FACTOR * movMult * (actualAway - eAway);
  h.matches += 1;
  a.matches += 1;
  h.lastUpdated = new Date().toISOString();
  a.lastUpdated = new Date().toISOString();

  saveState();
}

// ── Bootstrap from ESPN ──────────────────────────────────

async function fetchEspnDay(dateStr: string): Promise<Array<{ home: string; away: string; hg: number; ag: number }>> {
  const formatted = dateStr.replace(/-/g, '');
  const results: Array<{ home: string; away: string; hg: number; ag: number }> = [];

  const out = await Promise.allSettled(
    ESPN_LEAGUES.map(async (league) => {
      const res = await fetch(
        `${ESPN_BASE}/site/v2/sports/soccer/${league}/scoreboard?dates=${formatted}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as {
        events?: Array<{
          competitions: Array<{
            status: { type: { state: string } };
            competitors: Array<{
              homeAway: string;
              team: { displayName: string };
              score?: { value: number } | string;
            }>;
          }>;
        }>;
      };
      const rows: Array<{ home: string; away: string; hg: number; ag: number }> = [];
      for (const event of data.events || []) {
        const comp = event.competitions?.[0];
        if (!comp || comp.status.type.state !== 'post') continue;
        const homeC = comp.competitors.find(c => c.homeAway === 'home');
        const awayC = comp.competitors.find(c => c.homeAway === 'away');
        if (!homeC || !awayC) continue;
        const hg = typeof homeC.score === 'object' ? homeC.score?.value : parseInt(String(homeC.score ?? ''), 10);
        const ag = typeof awayC.score === 'object' ? awayC.score?.value : parseInt(String(awayC.score ?? ''), 10);
        if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
        rows.push({ home: homeC.team.displayName, away: awayC.team.displayName, hg: hg as number, ag: ag as number });
      }
      return rows;
    }),
  );
  for (const r of out) if (r.status === 'fulfilled') results.push(...r.value);
  return results;
}

/**
 * Seed ratings from historical ESPN scores. Safe to call multiple times —
 * once bootstrappedAt is set, we skip. Runs in chronological order so the
 * rating trajectory is as close to real as possible.
 */
export async function bootstrapEloFromEspn(): Promise<{ matchesSeeded: number; teamsSeen: number }> {
  if (bootstrappedAt) {
    return { matchesSeeded: 0, teamsSeen: teams.size };
  }

  const now = new Date();
  let matchesSeeded = 0;
  const days: string[] = [];
  for (let i = BOOTSTRAP_DAYS; i >= 1; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    days.push(d.toISOString().slice(0, 10));
  }

  logger.info({ days: days.length, leagues: ESPN_LEAGUES.length }, 'Bootstrapping ELO from ESPN');

  // Batch in chunks to avoid flooding ESPN.
  const CHUNK = 5;
  for (let i = 0; i < days.length; i += CHUNK) {
    const slice = days.slice(i, i + CHUNK);
    const chunkResults = await Promise.all(slice.map(fetchEspnDay));
    for (const day of chunkResults) {
      for (const m of day) {
        updateFromResult(m.home, m.away, m.hg, m.ag);
        matchesSeeded++;
      }
    }
  }

  bootstrappedAt = new Date().toISOString();
  saveState();

  logger.info({ matchesSeeded, teams: teams.size }, 'ELO bootstrap complete');
  return { matchesSeeded, teamsSeen: teams.size };
}

// ── Public: stats ────────────────────────────────────────

export function getEloStats(): {
  teams: number;
  bootstrappedAt: string | null;
  top10: Array<{ team: string; rating: number; matches: number }>;
} {
  const top10 = [...teams.entries()]
    .map(([team, t]) => ({ team, rating: Math.round(t.rating), matches: t.matches }))
    .filter(x => x.matches >= 3)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 10);
  return { teams: teams.size, bootstrappedAt, top10 };
}
