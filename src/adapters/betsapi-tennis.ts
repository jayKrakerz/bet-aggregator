import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * BetsAPI Tennis adapter (betsapi.com/t/tennis).
 *
 * STATUS: Site is behind Cloudflare challenge. Changed to browser
 * fetch to attempt bypassing the JS challenge.
 *
 * Server-rendered site with odds comparison, match data, and community tips.
 * Displays upcoming tennis matches with odds from multiple bookmakers.
 *
 * Expected page structure:
 *   - Match table: `table.table`, `.events-table`, `table.odds-table`
 *   - League/tournament headers: `tr.league-header`, `thead th`, `.league-name`
 *   - Match rows: `tr.match-row`, `tbody tr` with match data
 *   - Player names: `td.team a`, `td.player a`, cells with player links
 *   - Odds columns: `td.odds`, `td.bet365`, `td.pinnacle` with decimal odds
 *   - Date/time: `td.time`, `td.date` with match start time
 *   - Tips section: `.tips`, `.community-tips` with user-submitted predictions
 *   - Tip counts: `.tip-count`, `.votes` showing community consensus
 */
export class BetsApiTennisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'betsapi-tennis',
    name: 'BetsAPI Tennis',
    baseUrl: 'https://www.betsapi.com',
    fetchMethod: 'browser',
    paths: {
      tennis: '/t/tennis',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentTournament = '';
    let currentDate = fetchedAt.toISOString().split('T')[0]!;

    $('table.table tr, .events-table tr, table.odds-table tr, table tr').each((_i, el) => {
      const $row = $(el);
      const cells = $row.find('td');

      // Tournament/league header rows
      if ($row.hasClass('league-header') || cells.length === 0) {
        const headerText = $row.find('th, td').first().text().trim();
        if (headerText) currentTournament = headerText;
        return;
      }

      if (cells.length < 3) return;

      // Extract player names
      const playerLinks = $row.find('td.team a, td.player a, td a[href*="/team/"], td a[href*="/player/"]');
      let player1 = '';
      let player2 = '';

      if (playerLinks.length >= 2) {
        player1 = $(playerLinks[0]).text().trim();
        player2 = $(playerLinks[1]).text().trim();
      } else {
        // Look for "Player1 vs Player2" pattern
        const rowText = $row.text();
        const vsMatch = rowText.match(/([A-Z][a-zA-Z.\-' ]+?)\s+(?:vs?\.?|[-])\s+([A-Z][a-zA-Z.\-' ]+)/i);
        if (vsMatch) {
          player1 = vsMatch[1]!.trim();
          player2 = vsMatch[2]!.trim();
        }
      }

      if (!player1 || !player2) return;

      // Extract odds to determine favorite
      const oddsCells = $row.find('td.odds, td[class*="odds"], td.bet365, td.pinnacle');
      let homeOdds = 0;
      let awayOdds = 0;
      if (oddsCells.length >= 2) {
        homeOdds = parseFloat($(oddsCells[0]).text().trim()) || 0;
        awayOdds = parseFloat($(oddsCells[1]).text().trim()) || 0;
      } else {
        // Look for odds values in cells
        cells.each((_j, cell) => {
          const text = $(cell).text().trim();
          const oddsMatch = text.match(/^(\d+\.\d{2})$/);
          if (oddsMatch) {
            const val = parseFloat(oddsMatch[1]!);
            if (val >= 1.01 && val <= 50) {
              if (homeOdds === 0) homeOdds = val;
              else if (awayOdds === 0) awayOdds = val;
            }
          }
        });
      }

      // Lower odds = more likely winner
      let side: Side = 'home';
      if (homeOdds > 0 && awayOdds > 0) {
        side = homeOdds <= awayOdds ? 'home' : 'away';
      }

      // Extract community tip votes if present
      const tipVotes = $row.find('.tip-count, .votes, [class*="vote"]');
      let confidence = this.oddsToConfidence(homeOdds, awayOdds);

      if (tipVotes.length >= 2) {
        const v1 = parseInt($(tipVotes[0]).text().trim(), 10) || 0;
        const v2 = parseInt($(tipVotes[1]).text().trim(), 10) || 0;
        if (v1 + v2 > 0) {
          const maxPct = Math.round((Math.max(v1, v2) / (v1 + v2)) * 100);
          side = v1 >= v2 ? 'home' : 'away';
          confidence = this.pctToConfidence(maxPct);
        }
      }

      // Extract date/time
      const timeText = $row.find('td.time, td.date, td:first-child').first().text().trim();
      const dateMatch = timeText.match(/(\d{1,2})[./](\d{1,2})[./]?(\d{2,4})?/);
      if (dateMatch) {
        const day = dateMatch[1]!.padStart(2, '0');
        const month = dateMatch[2]!.padStart(2, '0');
        const year = dateMatch[3]
          ? (dateMatch[3].length === 2 ? `20${dateMatch[3]}` : dateMatch[3])
          : fetchedAt.getFullYear().toString();
        currentDate = `${year}-${month}-${day}`;
      }

      const timeMatch = timeText.match(/(\d{1,2}:\d{2})/);
      const gameTime = timeMatch ? timeMatch[1]! : null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate: currentDate,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'BetsAPI',
        confidence,
        reasoning: [
          currentTournament,
          homeOdds > 0 ? `Odds: ${homeOdds} - ${awayOdds}` : '',
        ].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private oddsToConfidence(homeOdds: number, awayOdds: number): RawPrediction['confidence'] {
    if (homeOdds <= 0 || awayOdds <= 0) return null;
    const favoriteOdds = Math.min(homeOdds, awayOdds);
    const impliedProb = (1 / favoriteOdds) * 100;
    if (impliedProb >= 80) return 'best_bet';
    if (impliedProb >= 65) return 'high';
    if (impliedProb >= 50) return 'medium';
    return 'low';
  }

  private pctToConfidence(pct: number): RawPrediction['confidence'] {
    if (pct >= 80) return 'best_bet';
    if (pct >= 65) return 'high';
    if (pct >= 50) return 'medium';
    return 'low';
  }
}
