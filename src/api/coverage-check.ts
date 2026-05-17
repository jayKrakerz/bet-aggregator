/**
 * Fast in-memory coverage probe.
 *
 * Answers: "would the predictor have real data for this fixture, or fall
 * through to the generic prior?" — by checking only the in-memory indexes
 * (CSV cache, ESPN team index, flashscore team index). No HTTP fetches,
 * no per-team API calls. Cheap enough to run on every live-game card.
 *
 * Returns the FIRST source where both teams resolve confidently. When
 * none match, the caller can render a 📭 / hide the fixture.
 *
 * What it does NOT check: API-Football (HTTP), Onefootball (HTTP),
 * OpenLigaDB (requires per-season fetch). False negatives are possible —
 * a fixture marked uncovered might still resolve via those slower
 * sources when the predictor actually runs. We accept that tradeoff in
 * favour of speed.
 */

import { hasCsvTeam } from './stats-predictor.js';
import { findEspnTeamCandidates } from './espn-form.js';
import { getFlashscoreRecentMatches } from './flashscore-form.js';

export type CoverageSource = 'csv-poisson' | 'espn' | 'flashscore' | 'none';

export interface CoverageResult {
  source: CoverageSource;
  /** True when both teams resolved in the same source. */
  confident: boolean;
}

export function probeCoverage(home: string, away: string, leagueHint?: string): CoverageResult {
  // 1. csv-poisson — most reliable when it hits.
  const hCsv = hasCsvTeam(home, leagueHint);
  const aCsv = hasCsvTeam(away, leagueHint);
  if (hCsv && aCsv) return { source: 'csv-poisson', confident: hCsv.league === aCsv.league };

  // 2. ESPN team-index (~58 leagues; broad coverage).
  const hEspn = findEspnTeamCandidates(home);
  const aEspn = findEspnTeamCandidates(away);
  if (hEspn.length > 0 && aEspn.length > 0) {
    // Confident when both candidates share a leagueSlug.
    const sharedLeague = hEspn.some(h => aEspn.some(a => a.leagueSlug === h.leagueSlug));
    return { source: 'espn', confident: sharedLeague };
  }

  // 3. Flashscore rolling-60d index. Lower confidence but broad.
  const hFs = getFlashscoreRecentMatches(home, 1);
  const aFs = getFlashscoreRecentMatches(away, 1);
  if (hFs && aFs) return { source: 'flashscore', confident: false };

  return { source: 'none', confident: false };
}
