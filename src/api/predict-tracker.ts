/**
 * Predict Tracker — persistence + calibration for /match-predict outputs.
 *
 * Inspired by FootStats v3.3's calibration.py: log every prediction we make,
 * settle pending ones by checking finished-match results in the flashscore.mobi
 * rolling index, then compute a recent hit-rate. The match-predictor applies
 * that hit-rate as a small multiplicative haircut/boost to its reported
 * confidence — so a stretch of wrong predictions visibly trims the next
 * confidence figure shown to the user.
 *
 * Storage: Vercel KV when configured (production), otherwise a JSON file on
 * disk for local development. Ring-buffer at LOG_CAP entries so the log
 * doesn't grow without bound.
 */

import fs from 'node:fs';
import path from 'node:path';
import { kv } from '@vercel/kv';

import { logger } from '../utils/logger.js';
import { findFinishedMatch } from './flashscore-form.js';

// ── Storage config ──────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'predict_log.json');
const KV_KEY = 'predict:log:v1';
const USE_KV = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

const LOG_CAP = 200;                  // ring-buffer size
const HIT_RATE_WINDOW = 30;           // measure over last N settled
const SETTLE_LOOKAHEAD_DAYS = 7;      // a prediction is searchable for this long

// ── Types ────────────────────────────────────────────────

export interface PredictionLog {
  id: string;                         // home|away|YYYY-MM-DD
  home: string;
  away: string;
  pick: 'Home' | 'Draw' | 'Away';
  confidence: number;
  expected: { home: number; away: number };
  predictedAt: string;                // ISO timestamp
  status: 'pending' | 'won' | 'lost' | 'void';
  settledAt: string | null;
  actualScore: { home: number; away: number } | null;
}

interface PersistedLog {
  version: 1;
  entries: PredictionLog[];
}

// ── In-memory mirror ────────────────────────────────────

let entries: PredictionLog[] = [];
let loadedOnce = false;
let loadInflight: Promise<void> | null = null;

async function loadAsync(): Promise<void> {
  if (USE_KV) {
    try {
      const raw = await kv.get<PersistedLog>(KV_KEY);
      if (raw && Array.isArray(raw.entries)) {
        entries = raw.entries.slice(-LOG_CAP);
        loadedOnce = true;
        return;
      }
    } catch (err) {
      logger.warn({ err }, 'predict-tracker: KV read failed, falling back to fs');
    }
  }
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as PersistedLog;
      entries = Array.isArray(raw?.entries) ? raw.entries.slice(-LOG_CAP) : [];
    }
  } catch (err) {
    logger.warn({ err }, 'predict-tracker: fs load failed; starting empty');
    entries = [];
  }
  loadedOnce = true;
}

async function ensureLoaded(): Promise<void> {
  if (loadedOnce) return;
  if (!loadInflight) loadInflight = loadAsync().finally(() => { loadInflight = null; });
  await loadInflight;
}

// ── Debounced persist ───────────────────────────────────

const DEBOUNCE_MS = 1500;
let saveTimer: NodeJS.Timeout | null = null;
let saving = false;
let savePending = false;

async function persistNow(): Promise<void> {
  const blob: PersistedLog = { version: 1, entries: entries.slice(-LOG_CAP) };
  if (USE_KV) {
    try {
      await kv.set(KV_KEY, blob);
      return;
    } catch (err) {
      logger.warn({ err }, 'predict-tracker: KV write failed, falling back to fs');
    }
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(blob));
  } catch (err) {
    logger.warn({ err }, 'predict-tracker: fs write failed');
  }
}

function schedulePersist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (saving) { savePending = true; return; }
    saving = true;
    try { await persistNow(); } finally {
      saving = false;
      if (savePending) { savePending = false; schedulePersist(); }
    }
  }, DEBOUNCE_MS);
}

// ── Public API ──────────────────────────────────────────

/** Record a fresh prediction. Idempotent on (home, away, YYYY-MM-DD). */
export async function logPrediction(p: {
  home: string;
  away: string;
  pick: 'Home' | 'Draw' | 'Away';
  confidence: number;
  expHome: number;
  expAway: number;
}): Promise<void> {
  await ensureLoaded();
  const date = new Date().toISOString().slice(0, 10);
  const id = `${normalise(p.home)}|${normalise(p.away)}|${date}`;
  // Dedup: if we already have a pending log for this same fixture today,
  // skip — confidence updates within the day shouldn't multiply our sample.
  if (entries.some(e => e.id === id && e.status === 'pending')) return;
  entries.push({
    id,
    home: p.home,
    away: p.away,
    pick: p.pick,
    confidence: p.confidence,
    expected: { home: p.expHome, away: p.expAway },
    predictedAt: new Date().toISOString(),
    status: 'pending',
    settledAt: null,
    actualScore: null,
  });
  if (entries.length > LOG_CAP) entries = entries.slice(-LOG_CAP);
  schedulePersist();
}

function normalise(s: string): string {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Try to settle every pending log against flashscore.mobi's current
 *  rolling-window results. Lazy — called from getCalibration(). */
async function settlePending(): Promise<{ settled: number; pending: number }> {
  await ensureLoaded();
  let settled = 0;
  for (const entry of entries) {
    if (entry.status !== 'pending') continue;
    const predDate = entry.predictedAt.slice(0, 10);
    const ageDays = (Date.now() - Date.parse(entry.predictedAt)) / 86_400_000;
    if (ageDays > SETTLE_LOOKAHEAD_DAYS) {
      entry.status = 'void';
      entry.settledAt = new Date().toISOString();
      continue;
    }
    const result = await findFinishedMatch(entry.home, entry.away, predDate);
    if (!result) continue;
    const won = checkPick(entry.pick, result.homeGoals, result.awayGoals);
    entry.status = won ? 'won' : 'lost';
    entry.actualScore = { home: result.homeGoals, away: result.awayGoals };
    entry.settledAt = new Date().toISOString();
    settled++;
  }
  if (settled > 0) schedulePersist();
  const pending = entries.filter(e => e.status === 'pending').length;
  return { settled, pending };
}

function checkPick(pick: 'Home' | 'Draw' | 'Away', hg: number, ag: number): boolean {
  if (pick === 'Home') return hg > ag;
  if (pick === 'Away') return ag > hg;
  return hg === ag;
}

/** Recent hit-rate over the last HIT_RATE_WINDOW settled predictions, and the
 *  multiplier we apply to displayed confidence (centered on 1.0 at 70% hit-rate). */
export async function getCalibration(): Promise<{
  totalSettled: number;
  recentWindow: number;
  hitRate: number;            // 0..1, NaN-safe
  confidenceMult: number;     // 0.7..1.2
  lastSettled: PredictionLog[];
  pendingCount: number;
}> {
  await ensureLoaded();
  // Best-effort settle — never fail the caller if flashscore is down.
  try { await settlePending(); } catch (err) { logger.warn({ err }, 'predict-tracker: settle pass failed'); }

  const settled = entries.filter(e => e.status === 'won' || e.status === 'lost');
  const recent = settled.slice(-HIT_RATE_WINDOW);
  const wins = recent.filter(e => e.status === 'won').length;
  const total = recent.length;
  const hitRate = total > 0 ? wins / total : NaN;

  // Center on 0.70 (a reasonable baseline confidence). Hot model gets a
  // small boost; cold model gets a haircut. Capped 0.7..1.2.
  let mult = 1;
  if (total >= 5 && Number.isFinite(hitRate)) {
    mult = 0.7 + (hitRate / 0.70) * 0.3;
    mult = Math.max(0.7, Math.min(1.2, mult));
  }

  return {
    totalSettled: settled.length,
    recentWindow: total,
    hitRate,
    confidenceMult: Math.round(mult * 1000) / 1000,
    lastSettled: settled.slice(-10).reverse(),
    pendingCount: entries.filter(e => e.status === 'pending').length,
  };
}

/** Synchronous read of last-known calibration multiplier — used in the hot
 *  path so we don't block /match-predict on a settle pass. */
let cachedMult = 1;
let cachedAt = 0;
const CACHE_MS = 60_000;

export async function getCachedConfidenceMult(): Promise<number> {
  if (Date.now() - cachedAt < CACHE_MS) return cachedMult;
  cachedAt = Date.now();
  try {
    const c = await getCalibration();
    cachedMult = c.confidenceMult;
  } catch (err) {
    logger.warn({ err }, 'predict-tracker: cached mult refresh failed');
  }
  return cachedMult;
}
