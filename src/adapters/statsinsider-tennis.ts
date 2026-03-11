import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * StatsInsider Tennis adapter (statsinsider.com.au/tennis).
 *
 * STATUS: PARTIALLY WORKING - Angular SSR app using `app-match-tile`
 * custom elements. The sidebar shows match tiles for various sports with
 * `.team-name`, `.team-prob`, `.team-line`, `.team-row` selectors.
 * The Angular transfer state (JSON in `script[type="application/json"]`)
 * contains CMS article data, not match predictions.
 *
 * As of 2026-03-10, the /tennis/predictions page renders sidebar match
 * tiles for other sports (CBB, NBA) but the main content area for tennis
 * predictions may not be populated or may require additional navigation.
 * The adapter parses `app-match-tile` elements which use:
 *   - `.team-name` for team/player abbreviations
 *   - `.team-prob` for win probability percentage (e.g. "60%")
 *   - `.team-line` (inside `.bet-desc`) for spread (e.g. "-3.5")
 *   - `.team-row` wrapping each team's data
 *   - Match time in text like "4:30PM, Mar 10"
 *   - Sport label like "CBB", "NBA", "Tennis" in text
 */
export class StatsInsiderTennisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'statsinsider-tennis',
    name: 'StatsInsider Tennis',
    baseUrl: 'https://www.statsinsider.com.au',
    fetchMethod: 'browser',
    paths: {
      tennis: '/tennis/predictions',
    },
    cron: '0 0 5,11,17 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 8000 },
  };

  async browserActions(page: Page): Promise<void> {
    // StatsInsider is Angular SSR - wait for app-match-tile custom elements
    await page.waitForSelector('app-match-tile, .team-row, .match-carousel', {
      timeout: 15000,
    }).catch(() => {});
    await page.waitForTimeout(3000);
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Try Angular transfer state JSON
    $('script[type="application/json"]').each((_i, el) => {
      const content = $(el).html() || '';
      if (content.length < 100) return;
      try {
        const state = JSON.parse(content);
        for (const [, val] of Object.entries(state)) {
          if (typeof val !== 'object' || val === null) continue;
          const obj = val as Record<string, unknown>;
          if (!obj.b || typeof obj.b !== 'string') continue;
          try {
            const body = JSON.parse(obj.b as string);
            if (body.objects && Array.isArray(body.objects)) {
              for (const item of body.objects) {
                const pred = this.parseJsonMatch(item as Record<string, unknown>, sport, fetchedAt);
                if (pred) predictions.push(pred);
              }
            }
          } catch { /* not parseable */ }
        }
      } catch { /* not JSON */ }
    });
    if (predictions.length > 0) return predictions;

    // DOM parsing: StatsInsider uses `app-match-tile` Angular custom elements.
    // Each tile contains:
    //   - `.team-row` wrapping each team (2 per tile)
    //   - `.team-name` for the team/player abbreviation
    //   - `.team-prob` for win probability (e.g. "60%")
    //   - `.team-line` (inside `.bet-desc`) for spread value
    // Match time/date text appears before team rows.
    // Sport label (CBB, NBA, Tennis) appears in the tile text.
    $('app-match-tile, app-mini-match-tile, .game-link').each((_i, el) => {
      const $tile = $(el);
      const fullText = $tile.text().trim().replace(/\s+/g, ' ');

      // Filter by sport - only parse tennis matches for tennis adapter.
      // Check tile text AND parent game-sport-group for sport label.
      const parentGroup = $tile.closest('.game-sport-group').text().trim().replace(/\s+/g, ' ');
      const combinedText = fullText + ' ' + parentGroup;
      const sportLabel = combinedText.match(/\b(Tennis|ATP|WTA|CBB|NBA|NFL|NHL|MLB|College Basketball|Premier League)\b/i);
      const matchSport = sportLabel ? sportLabel[1]!.toUpperCase() : '';
      // Only include tennis-related matches; skip if sport detected but not tennis
      if (!matchSport || !['TENNIS', 'ATP', 'WTA'].includes(matchSport)) return;

      // Team names may be in .team-name spans (full names in app-match-tile)
      // or in .team-name > span (abbreviations in app-mini-match-tile)
      const teamNames = $tile.find('.team-name');
      if (teamNames.length < 2) return;

      const player1 = $(teamNames[0]).find('span').first().text().trim() || $(teamNames[0]).text().trim();
      const player2 = $(teamNames[1]).find('span').first().text().trim() || $(teamNames[1]).text().trim();
      if (!player1 || !player2) return;

      // Win probabilities
      const probEls = $tile.find('.team-prob');
      let p1Prob = 0;
      let p2Prob = 0;
      if (probEls.length >= 2) {
        p1Prob = parseInt($(probEls[0]).text().replace('%', '').trim(), 10) || 0;
        p2Prob = parseInt($(probEls[1]).text().replace('%', '').trim(), 10) || 0;
      }

      // Spread values
      const lineEls = $tile.find('.team-line');
      let spreadVal: number | null = null;
      if (lineEls.length >= 1) {
        spreadVal = this.parseSpreadValue($(lineEls[0]).text().trim());
      }

      const side: Side = p1Prob >= p2Prob ? 'home' : 'away';
      const maxProb = Math.max(p1Prob, p2Prob);

      // Extract time from .game-info span or tile text (e.g. "4:30PM, Mar 10")
      const gameInfoText = $tile.find('.game-info span').first().text().trim();
      const timeMatch = (gameInfoText || fullText).match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate: today,
        gameTime: timeMatch ? timeMatch[1]! : null,
        pickType: spreadVal !== null ? 'spread' : 'moneyline',
        side,
        value: spreadVal,
        pickerName: 'StatsInsider AI',
        confidence: this.probToConfidence(maxProb),
        reasoning: maxProb > 0 ? `Win prob: ${p1Prob}%-${p2Prob}%` : null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseJsonMatch(
    match: Record<string, unknown>,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction | null {
    const player1 = (match.homePlayer || match.player1 || match.homeTeam) as string | undefined;
    const player2 = (match.awayPlayer || match.player2 || match.awayTeam) as string | undefined;
    if (!player1 || !player2) return null;

    const p1Name = typeof player1 === 'object' ? (player1 as Record<string, string>).name : player1;
    const p2Name = typeof player2 === 'object' ? (player2 as Record<string, string>).name : player2;
    if (!p1Name || !p2Name) return null;

    const p1Prob = (match.homeWinProb || match.player1WinProb || 0) as number;
    const p2Prob = (match.awayWinProb || match.player2WinProb || 0) as number;
    const side: Side = p1Prob >= p2Prob ? 'home' : 'away';
    const maxProb = Math.max(p1Prob, p2Prob);
    // Convert 0-1 range to percentage if needed
    const maxProbPct = maxProb <= 1 ? Math.round(maxProb * 100) : Math.round(maxProb);

    const startTime = match.startTime as string | number | undefined;
    let gameDate = fetchedAt.toISOString().split('T')[0]!;
    let gameTime: string | null = null;
    if (typeof startTime === 'string') {
      const isoMatch = startTime.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (isoMatch) gameDate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    } else if (typeof startTime === 'number') {
      const d = new Date(startTime * 1000);
      gameDate = d.toISOString().split('T')[0]!;
      const hours = d.getUTCHours();
      const mins = d.getUTCMinutes();
      if (hours !== 0 || mins !== 0) {
        const period = hours >= 12 ? 'PM' : 'AM';
        const h = hours % 12 || 12;
        gameTime = `${h}:${mins.toString().padStart(2, '0')} ${period}`;
      }
    }

    const tournament = (match.tournament || match.event || match.competition) as string | undefined;

    return {
      sourceId: this.config.id,
      sport,
      homeTeamRaw: p1Name,
      awayTeamRaw: p2Name,
      gameDate,
      gameTime,
      pickType: 'moneyline',
      side,
      value: null,
      pickerName: 'StatsInsider AI',
      confidence: this.probToConfidence(maxProbPct),
      reasoning: [
        tournament || '',
        `Win prob: ${maxProbPct}%`,
      ].filter(Boolean).join(' | ') || null,
      fetchedAt,
    };
  }

  private probToConfidence(prob: number): RawPrediction['confidence'] {
    if (prob >= 80) return 'best_bet';
    if (prob >= 65) return 'high';
    if (prob >= 50) return 'medium';
    if (prob > 0) return 'low';
    return null;
  }
}
