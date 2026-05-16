/**
 * Manual O/U Lookup
 *
 * Takes a home team + away team (and optional league hint) and returns:
 *   - Expected goals (Poisson lambdas) for each side
 *   - Over/Under probabilities at the standard lines (0.5 → 4.5)
 *   - BTTS yes/no
 *   - Per-team form breakdown: W/D/L, goals for/against, home vs away splits, last-N results
 *   - Head-to-head: combined record + last meetings
 *   - SRL empirical form on top, when both teams appear in the SRL history
 *
 * Honest about what's missing: real-world Poisson is the primary signal.
 * If the league isn't covered (we cover ~12 European top flights) we fall
 * back to a generic football prior and flag it.
 */

import { logger } from '../utils/logger.js';
import {
  predictMatch,
  getTeamFormDetail,
  getH2HDetail,
  getLeagueAverages,
  type TeamFormDetail,
  type H2HDetail,
  type PoissonPrediction,
} from './stats-predictor.js';
import { stripSrl } from './srl-fixtures.js';
import { computeLeaguePriors, computeTeamForm, type LeaguePrior, type TeamForm } from './srl-history.js';
import { lookupViaApiFootball, hasApiFootballKey, getApiFootballQuota, type ApiFootballForm } from './api-football-form.js';
import { lookupViaEspn, preloadEspnTeams, type EspnTeamForm } from './espn-form.js';
import { lookupViaFlashscore, type FlashscoreTeamForm } from './flashscore-form.js';

export interface OuLine {
  line: number;
  overPct: number;
  underPct: number;
}

/**
 * Trust grading attached to every lookup so callers (and the UI) can tell
 * when the predicted lambdas come from solid data vs a junk fuzzy match.
 *
 *   solid       — both teams matched in the same league; league hint (if
 *                 supplied) aligns. Trust the prediction.
 *   partial     — both teams matched but in different leagues or league
 *                 hint mismatched. Treat with mild caution.
 *   weak        — only one side matched, or matched via a low-confidence
 *                 source. Useful as a sanity check, not for staking.
 *   unreliable  — generic-prior fallback fired. Lambdas are just league
 *                 averages with no team specificity. Don't bet on this.
 */
export type PredictionQuality = 'solid' | 'partial' | 'weak' | 'unreliable';

export interface QualityAssessment {
  grade: PredictionQuality;
  /** Internal 0–100 score driving the grade — exposed for debugging. */
  score: number;
  /** Bullet-style reasons that contributed (always non-empty). */
  reasons: string[];
  /** True when the UI should display a prominent warning and de-emphasise
   *  verdict / Decision Score / Kelly stake. */
  warn: boolean;
}

export interface OuLookupResult {
  homeInput: string;
  awayInput: string;
  homeNormalized: string;
  awayNormalized: string;
  league: string | null;
  matched: boolean;
  /** True when neither CSV-Poisson nor API-Football could resolve both teams. */
  usedFallback: boolean;
  /** Which data source produced the prediction: */
  source: 'csv-poisson' | 'espn' | 'api-football' | 'flashscore' | 'generic';
  reason: string | null;
  expected: { home: number; away: number; total: number };
  ou: OuLine[];
  bttsYesPct: number;
  bttsNoPct: number;
  homePct: number;
  drawPct: number;
  awayPct: number;
  factors: {
    homeForm: TeamFormDetail | null;
    awayForm: TeamFormDetail | null;
    h2h: H2HDetail | null;
    leagueAverages: { league: string; avgHomeGoals: number; avgAwayGoals: number; matches: number } | null;
    /** Populated when source='api-football'. Different shape from csv-poisson form. */
    apiFootballHomeForm: ApiFootballForm | null;
    apiFootballAwayForm: ApiFootballForm | null;
    /** Populated when source='espn'. Same fields as ApiFootballForm, different source. */
    espnHomeForm: EspnTeamForm | null;
    espnAwayForm: EspnTeamForm | null;
    /** Populated when source='flashscore'. Derived from flashscore.mobi's 60-day rolling results. */
    flashscoreHomeForm: FlashscoreTeamForm | null;
    flashscoreAwayForm: FlashscoreTeamForm | null;
  };
  srl: {
    leaguePrior: LeaguePrior | null;
    homeSrlForm: TeamForm | null;
    awaySrlForm: TeamForm | null;
  };
  apiFootball: {
    enabled: boolean;
    quotaUsed: number;
    quotaCap: number;
  };
  quality: QualityAssessment;
}

// ── Poisson math (kept local so we can hit any line, not just the few
//    the stats-predictor exposes). ──────────────────────────────────

function pmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / f;
}

function ouAt(line: number, lambdaH: number, lambdaA: number, maxGoals = 8): { overPct: number; underPct: number } {
  let over = 0;
  let under = 0;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const total = h + a;
      const p = pmf(h, lambdaH) * pmf(a, lambdaA);
      if (total > line) over += p;
      else under += p;
    }
  }
  const r = (x: number) => Math.round(x * 1000) / 10;
  return { overPct: r(over), underPct: r(under) };
}

function btts(lambdaH: number, lambdaA: number, maxGoals = 8): { yesPct: number; noPct: number } {
  let yes = 0;
  for (let h = 1; h <= maxGoals; h++) {
    for (let a = 1; a <= maxGoals; a++) {
      yes += pmf(h, lambdaH) * pmf(a, lambdaA);
    }
  }
  const r = (x: number) => Math.round(x * 1000) / 10;
  return { yesPct: r(yes), noPct: r(1 - yes) };
}

function r2(x: number): number { return Math.round(x * 100) / 100; }

// Generic football fallback if no league coverage.
const GENERIC_AVG_HOME_GOALS = 1.55;
const GENERIC_AVG_AWAY_GOALS = 1.20;

const STANDARD_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];

/**
 * football-data.co.uk uses abbreviated names. Expand the common typed
 * forms here so users can enter "Manchester City" instead of "Man City".
 * Matching is then handled by the predictor's existing fuzzy logic.
 */
const TEAM_ALIASES: Record<string, string> = {
  'manchester city': 'Man City',
  'man city': 'Man City',
  'manchester united': 'Man United',
  'manchester utd': 'Man United',
  'man utd': 'Man United',
  'man united': 'Man United',
  'wolverhampton': 'Wolves',
  'wolverhampton wanderers': 'Wolves',
  'tottenham hotspur': 'Tottenham',
  'spurs': 'Tottenham',
  'brighton and hove albion': 'Brighton',
  'brighton & hove': 'Brighton',
  'newcastle united': 'Newcastle',
  'leeds united': 'Leeds',
  'west ham united': 'West Ham',
  'sheffield united': 'Sheffield United',
  'paris saint germain': 'Paris SG',
  'paris saint-germain': 'Paris SG',
  'psg': 'Paris SG',
  'inter milan': 'Inter',
  'internazionale': 'Inter',
  'ac milan': 'Milan',
  'as roma': 'Roma',
  'ss lazio': 'Lazio',
  'atletico madrid': 'Ath Madrid',
  'atletico de madrid': 'Ath Madrid',
  'atletico bilbao': 'Ath Bilbao',
  'athletic bilbao': 'Ath Bilbao',
  'real betis': 'Betis',
  'real sociedad': 'Sociedad',
  'rayo vallecano': 'Vallecano',
  'celta vigo': 'Celta',
  'fc porto': 'Porto',
  'sl benfica': 'Benfica',
  'sporting cp': 'Sp Lisbon',
  'sporting lisbon': 'Sp Lisbon',
  'sporting clube de portugal': 'Sp Lisbon',
  'borussia dortmund': 'Dortmund',
  'borussia monchengladbach': 'M\'gladbach',
  'borussia mgladbach': 'M\'gladbach',
  'bayer leverkusen': 'Leverkusen',
  'bayern munich': 'Bayern Munich',
  'fc bayern': 'Bayern Munich',
  'fc bayern munich': 'Bayern Munich',
  'eintracht frankfurt': 'Ein Frankfurt',
  // MLS
  'atlanta united': 'Atlanta Utd',
  'atlanta united fc': 'Atlanta Utd',
  'la galaxy': 'Los Angeles Galaxy',
  'lafc': 'Los Angeles FC',
  'la fc': 'Los Angeles FC',
  'red bulls': 'New York Red Bulls',
  'ny red bulls': 'New York Red Bulls',
  'nyc fc': 'New York City',
  'nycfc': 'New York City',
  'new york city fc': 'New York City',
  'st louis city': 'St. Louis City',
  'saint louis city': 'St. Louis City',
  'cf montréal': 'CF Montreal',
  // Liga Profesional (Argentina)
  'river plate': 'River Plate',
  'racing club': 'Racing Club',
  'estudiantes lp': 'Estudiantes',
  'estudiantes la plata': 'Estudiantes',
  'velez sarsfield': 'Velez Sarsfield',
  'argentinos juniors': 'Argentinos Jrs',
  'newells old boys': 'Newells Old Boys',
  // Brasileirao (Serie A BRA)
  'sao paulo fc': 'Sao Paulo',
  'são paulo': 'Sao Paulo',
  'palmeiras se': 'Palmeiras',
  'se palmeiras': 'Palmeiras',
  'atletico mineiro': 'Atletico-MG',
  'atletico-mg': 'Atletico-MG',
  'atletico paranaense': 'Athletico-PR',
  'athletico paranaense': 'Athletico-PR',
  'red bull bragantino': 'Bragantino',
  'rb bragantino': 'Bragantino',
  // Liga MX
  'club america': 'Club America',
  'cf america': 'Club America',
  'cruz azul': 'Cruz Azul',
  'monterrey rayados': 'Monterrey',
  // J League
  'urawa red diamonds': 'Urawa',
  'kashima antlers': 'Kashima',
  'yokohama f marinos': 'Yokohama F. Marinos',
  // Allsvenskan
  'malmo ff': 'Malmo FF',
  'ifk goteborg': 'Goteborg',
  'ifk göteborg': 'Goteborg',
  // Eredivisie / Eerste — RKC Waalwijk and Willem II Tilburg both currently
  // play in Dutch second tier (Eerste Divisie) which football-data.co.uk
  // doesn't publish, so these are intentional misses.
};

function expandAlias(name: string): string {
  const k = name.toLowerCase().trim();
  return TEAM_ALIASES[k] || name;
}

// ── Public API ──────────────────────────────────────────

export async function lookupOU(homeIn: string, awayIn: string, leagueHint?: string): Promise<OuLookupResult> {
  // Strip any SRL marker, then expand common aliases (e.g. "Manchester City"
  // → "Man City") so the predictor's fuzzy matcher can hit the CSV form.
  const home = expandAlias(stripSrl(homeIn).trim());
  const away = expandAlias(stripSrl(awayIn).trim());
  const league = leagueHint?.trim() || null;

  // Real-world Poisson on local CSVs — primary signal (35 leagues, 700+ teams).
  let expHome = GENERIC_AVG_HOME_GOALS;
  let expAway = GENERIC_AVG_AWAY_GOALS;
  let usedFallback = true;
  let matched = false;
  let source: 'csv-poisson' | 'espn' | 'api-football' | 'flashscore' | 'generic' = 'generic';
  let reason: string | null = null;
  let resolvedLeague: string | null = league;
  let pre: PoissonPrediction | null = null;
  let apiFootballHomeForm: ApiFootballForm | null = null;
  let apiFootballAwayForm: ApiFootballForm | null = null;
  let espnHomeForm: EspnTeamForm | null = null;
  let espnAwayForm: EspnTeamForm | null = null;
  let flashscoreHomeForm: FlashscoreTeamForm | null = null;
  let flashscoreAwayForm: FlashscoreTeamForm | null = null;

  try {
    pre = await predictMatch(home, away, league || undefined);
    if (pre) {
      expHome = pre.expectedHomeGoals;
      expAway = pre.expectedAwayGoals;
      usedFallback = false;
      matched = true;
      source = 'csv-poisson';
      resolvedLeague = pre.league;
    }
  } catch (err) {
    logger.warn({ err }, 'OU lookup: predictMatch failed');
  }

  // Fallback 1 (free): ESPN public soccer API. Covers ~21 leagues we
  // don't have locally — Honduras, Bolivia, Peru, Chile, Colombia,
  // Nigeria, Ghana, Saudi, Eredivisie 2 (where Waalwijk + Willem II
  // play), plus Champions League / Copa Libertadores rosters.
  if (!matched) {
    try {
      const espnResult = await lookupViaEspn(home, away);
      if (espnResult) {
        expHome = espnResult.expHomeGoals;
        expAway = espnResult.expAwayGoals;
        usedFallback = false;
        matched = true;
        source = 'espn';
        espnHomeForm = espnResult.homeForm;
        espnAwayForm = espnResult.awayForm;
        resolvedLeague = espnResult.league;
        if (!espnResult.sameLeague) {
          reason = 'Teams indexed in different ESPN leagues — lambdas are best-effort across competitions, treat as approximate.';
        }
      }
    } catch (err) {
      logger.warn({ err }, 'OU lookup: ESPN fallback failed');
    }
  }

  // Fallback 2 (paid quota): API-Football (covers 1300+ leagues —
  // catches anything ESPN missed, e.g. Egyptian Premier, Korean K-League,
  // women's, youth, reserves). Costs 4 API calls cold, 0 cached.
  if (!matched) {
    try {
      const apiResult = await lookupViaApiFootball(home, away);
      if (apiResult) {
        expHome = apiResult.expHomeGoals;
        expAway = apiResult.expAwayGoals;
        usedFallback = false;
        matched = true;
        source = 'api-football';
        apiFootballHomeForm = apiResult.homeForm;
        apiFootballAwayForm = apiResult.awayForm;
        resolvedLeague = apiResult.sameLeague
          ? apiResult.homeForm.league
          : `${apiResult.homeForm.league} vs ${apiResult.awayForm.league} (cross-league)`;
        if (!apiResult.sameLeague) {
          reason = 'Teams play in different leagues — lambdas are best-effort across competitions, treat as approximate.';
        }
      }
    } catch (err) {
      logger.warn({ err }, 'OU lookup: API-Football fallback failed');
    }
  }

  // Fallback 3 (free): flashscore.mobi 14-day rolling results. Catches the
  // niche leagues none of the above cover — Chilean Primera División Women,
  // Argentine Primera A Women, Bhutan Premier, Australian state leagues,
  // Eastern European 2nd divisions, etc. Plain HTTP, no Cloudflare, no key.
  // Cold cost: 15 page fetches (~3MB total) once per hour, cached for 1h.
  if (!matched) {
    try {
      const fsResult = await lookupViaFlashscore(home, away, league ?? undefined);
      if (fsResult) {
        expHome = fsResult.expHomeGoals;
        expAway = fsResult.expAwayGoals;
        usedFallback = false;
        matched = true;
        source = 'flashscore';
        flashscoreHomeForm = fsResult.homeForm;
        flashscoreAwayForm = fsResult.awayForm;
        resolvedLeague = fsResult.league;
        if (fsResult.partial !== 'none' && fsResult.partialReason) {
          reason = fsResult.partialReason;
        } else if (!fsResult.sameLeague) {
          reason = 'Teams indexed in different flashscore competitions — lambdas are best-effort across leagues, treat as approximate.';
        }
      }
    } catch (err) {
      logger.warn({ err }, 'OU lookup: flashscore.mobi fallback failed');
    }
  }

  if (!matched) {
    if (hasApiFootballKey()) {
      reason = 'Neither local CSVs, ESPN, API-Football, nor flashscore.mobi found these teams in the last 60 days. The fixture may be very low-tier (reserves, U-teams), exhibition friendlies, or use names that drifted between sources. Used a generic football prior.';
    } else {
      reason = 'No league coverage for this matchup — used a generic football prior. Local data covers ~35 leagues / 700+ teams; ESPN adds ~55 more; flashscore.mobi covers another ~150 leagues over a 60-day rolling window. To unlock 1300+ leagues with H2H + injuries set FOOTBALL_API_KEY env var (free signup at api-football.com).';
    }
  }

  // Build all lines.
  const ou = STANDARD_LINES.map(line => ({ line, ...ouAt(line, expHome, expAway) }));
  const b = btts(expHome, expAway);

  // 1X2 from the matrix (used for the side panel).
  let pH = 0, pD = 0, pA = 0;
  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const p = pmf(h, expHome) * pmf(a, expAway);
      if (h > a) pH += p;
      else if (h === a) pD += p;
      else pA += p;
    }
  }
  const r = (x: number) => Math.round(x * 1000) / 10;

  // Form, H2H, league averages — best-effort, may be null when not covered.
  const [homeForm, awayForm, h2h, leagueAverages] = await Promise.all([
    getTeamFormDetail(home, league || undefined).catch(() => null),
    getTeamFormDetail(away, league || undefined).catch(() => null),
    getH2HDetail(home, away, league || undefined).catch(() => null),
    resolvedLeague ? getLeagueAverages(resolvedLeague).catch(() => null) : null,
  ]);

  // SRL empirical form: keyed by realLeague + lowercased team name. We
  // try the resolved league first, then the leagueHint, then any league
  // that has both teams.
  let srlLeaguePrior: LeaguePrior | null = null;
  let homeSrlForm: TeamForm | null = null;
  let awaySrlForm: TeamForm | null = null;

  const priors = computeLeaguePriors();
  const allForm = computeTeamForm();

  const candidateLeagues: string[] = [];
  if (resolvedLeague) candidateLeagues.push(resolvedLeague);
  if (league && !candidateLeagues.includes(league)) candidateLeagues.push(league);
  for (const lp of priors.values()) {
    if (!candidateLeagues.includes(lp.realLeague)) candidateLeagues.push(lp.realLeague);
  }

  for (const lg of candidateLeagues) {
    const hKey = `${lg}|${home.toLowerCase()}`;
    const aKey = `${lg}|${away.toLowerCase()}`;
    const hForm = allForm.get(hKey) ?? null;
    const aForm = allForm.get(aKey) ?? null;
    if (hForm || aForm) {
      srlLeaguePrior = priors.get(lg) ?? null;
      homeSrlForm = hForm;
      awaySrlForm = aForm;
      break;
    }
  }

  const quota = getApiFootballQuota();
  const quality = assessQuality({
    usedFallback,
    source,
    matched,
    leagueHint: league,
    resolvedLeague,
    apiFootballHomeForm,
    apiFootballAwayForm,
    espnHomeForm,
    espnAwayForm,
    flashscoreHomeForm,
    flashscoreAwayForm,
    homeForm,
    awayForm,
  });

  return {
    homeInput: homeIn,
    awayInput: awayIn,
    homeNormalized: home,
    awayNormalized: away,
    league: resolvedLeague,
    matched,
    usedFallback,
    source,
    reason,
    expected: { home: r2(expHome), away: r2(expAway), total: r2(expHome + expAway) },
    ou,
    bttsYesPct: b.yesPct,
    bttsNoPct: b.noPct,
    homePct: r(pH),
    drawPct: r(pD),
    awayPct: r(pA),
    factors: {
      homeForm: homeForm ?? null,
      awayForm: awayForm ?? null,
      h2h: h2h ?? null,
      leagueAverages: leagueAverages ?? null,
      apiFootballHomeForm,
      apiFootballAwayForm,
      espnHomeForm,
      espnAwayForm,
      flashscoreHomeForm,
      flashscoreAwayForm,
    },
    srl: {
      leaguePrior: srlLeaguePrior,
      homeSrlForm,
      awaySrlForm,
    },
    apiFootball: {
      enabled: hasApiFootballKey(),
      quotaUsed: quota.used,
      quotaCap: quota.cap,
    },
    quality,
  };
}

// ── Quality assessment ─────────────────────────────────

// Only truly generic structural words. Words like "Premier" / "Primera"
// MUST stay — they're the distinguishing token in "Premier League" vs
// "Championship", "Primera División" vs "Segunda División".
const LEAGUE_HINT_STOP = new Set([
  'league','leagues','division','divisions','div','liga','ligue','serie',
  'football','soccer','fc','de','del','of','the','and',
]);

function leagueTokens(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  const tokens = s.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !LEAGUE_HINT_STOP.has(t));
  return new Set(tokens);
}

interface QualityInputs {
  usedFallback: boolean;
  source: OuLookupResult['source'];
  matched: boolean;
  leagueHint: string | null;
  resolvedLeague: string | null;
  apiFootballHomeForm: ApiFootballForm | null;
  apiFootballAwayForm: ApiFootballForm | null;
  espnHomeForm: EspnTeamForm | null;
  espnAwayForm: EspnTeamForm | null;
  flashscoreHomeForm: FlashscoreTeamForm | null;
  flashscoreAwayForm: FlashscoreTeamForm | null;
  homeForm: TeamFormDetail | null;
  awayForm: TeamFormDetail | null;
}

function assessQuality(q: QualityInputs): QualityAssessment {
  const reasons: string[] = [];
  let score = 100;

  // Generic-prior is the catastrophic case — no team data at all.
  if (!q.matched || q.usedFallback || q.source === 'generic') {
    reasons.push('No team-specific data — used a generic football prior. Lambdas are league-average guesses.');
    return { grade: 'unreliable', score: 0, reasons, warn: true };
  }

  // Source-confidence baseline. csv-poisson is the gold standard (full
  // season tables); api-football and espn are solid one-off lookups;
  // flashscore is a rolling 30-day fuzzy index — risky on niche leagues.
  if (q.source === 'csv-poisson') {
    reasons.push('Matched via football-data.co.uk seasonal CSVs (high confidence).');
  } else if (q.source === 'api-football') {
    reasons.push('Matched via API-Football (good confidence).');
  } else if (q.source === 'espn') {
    reasons.push('Matched via ESPN (good confidence).');
  } else if (q.source === 'flashscore') {
    reasons.push('Matched via flashscore.mobi rolling-30d index (lower confidence — fuzzy name matching).');
    score -= 15;
  }

  // Same-league signal across the lookup sources we used.
  const af = q.apiFootballHomeForm && q.apiFootballAwayForm;
  const afSame = af && q.apiFootballHomeForm!.league === q.apiFootballAwayForm!.league;
  const espn = q.espnHomeForm && q.espnAwayForm;
  const espnSame = espn && q.espnHomeForm!.league === q.espnAwayForm!.league && q.espnHomeForm!.country === q.espnAwayForm!.country;
  const fs = q.flashscoreHomeForm && q.flashscoreAwayForm;
  const fsSame = fs && q.flashscoreHomeForm!.league === q.flashscoreAwayForm!.league && q.flashscoreHomeForm!.country === q.flashscoreAwayForm!.country;

  if (q.source === 'api-football' && af && !afSame) {
    reasons.push('Teams matched in DIFFERENT API-Football leagues — cross-league lambdas, treat as approximate.');
    score -= 30;
  } else if (q.source === 'espn' && espn && !espnSame) {
    reasons.push('Teams matched in DIFFERENT ESPN leagues — cross-league lambdas, treat as approximate.');
    score -= 30;
  } else if (q.source === 'flashscore' && fs && !fsSame) {
    reasons.push('Teams matched in DIFFERENT flashscore competitions — cross-league lambdas, very unreliable.');
    score -= 35;
  }

  // One-sided match: only one team actually resolved. The other is filled
  // from a league prior, so the asymmetric lambda is partly a guess.
  if (q.source === 'flashscore' && fs == null && (q.flashscoreHomeForm || q.flashscoreAwayForm)) {
    const which = q.flashscoreHomeForm ? 'away' : 'home';
    reasons.push(`Only the ${which === 'away' ? 'home' : 'away'} side resolved on flashscore — the ${which} side is a league-average guess.`);
    score -= 25;
  }

  // League-hint alignment: when the user typed a hint, verify it shares at
  // least one meaningful token with the league we actually resolved.
  if (q.leagueHint && q.leagueHint.trim()) {
    const hintTokens = leagueTokens(q.leagueHint);
    const resolvedTokens = leagueTokens(q.resolvedLeague);
    if (hintTokens.size > 0 && resolvedTokens.size > 0) {
      let overlap = 0;
      for (const t of hintTokens) if (resolvedTokens.has(t)) overlap++;
      if (overlap === 0) {
        reasons.push(`League hint "${q.leagueHint}" doesn't match the resolved league "${q.resolvedLeague}" — wrong fixture matched.`);
        score -= 35;
      }
    }
  }

  // CSV form available is a big tiebreaker — means we have a real seasonal
  // record for at least one side that the predictor can use for H2H, form
  // splits, and league averages.
  if (q.source !== 'csv-poisson' && !q.homeForm && !q.awayForm) {
    reasons.push('No seasonal CSV form available for either side — no rich context.');
    score -= 5;
  }

  score = Math.max(0, Math.min(100, score));
  let grade: PredictionQuality;
  if (score >= 80) grade = 'solid';
  else if (score >= 55) grade = 'partial';
  else if (score >= 30) grade = 'weak';
  else grade = 'unreliable';

  // Warn loudly for weak and unreliable so the UI flags the prediction.
  const warn = grade === 'weak' || grade === 'unreliable';
  return { grade, score, reasons, warn };
}
