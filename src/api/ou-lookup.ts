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
    /** Populated when source='flashscore'. Derived from flashscore.mobi's 14-day rolling results. */
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
      const fsResult = await lookupViaFlashscore(home, away);
      if (fsResult) {
        expHome = fsResult.expHomeGoals;
        expAway = fsResult.expAwayGoals;
        usedFallback = false;
        matched = true;
        source = 'flashscore';
        flashscoreHomeForm = fsResult.homeForm;
        flashscoreAwayForm = fsResult.awayForm;
        resolvedLeague = fsResult.league;
        if (!fsResult.sameLeague) {
          reason = 'Teams indexed in different flashscore competitions — lambdas are best-effort across leagues, treat as approximate.';
        }
      }
    } catch (err) {
      logger.warn({ err }, 'OU lookup: flashscore.mobi fallback failed');
    }
  }

  if (!matched) {
    if (hasApiFootballKey()) {
      reason = 'Neither local CSVs, ESPN, API-Football, nor flashscore.mobi found these teams in the last 14 days. They may be very low-tier (reserves, U-teams), exhibition friendlies, or names that drifted between sources. Used a generic football prior.';
    } else {
      reason = 'No league coverage for this matchup — used a generic football prior. Local data covers 35 leagues / 700+ teams; ESPN adds ~20 more; flashscore.mobi covers another ~150 leagues over a 14-day rolling window. To extend further with H2H + injuries set FOOTBALL_API_KEY env var (free signup at api-football.com).';
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
  };
}
