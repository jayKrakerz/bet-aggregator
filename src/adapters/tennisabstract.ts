import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Tennis Abstract adapter (tennisabstract.com).
 *
 * Tennis Abstract provides statistical match previews and win probabilities
 * for upcoming professional tennis matches. Uses server-rendered HTML tables.
 *
 * Expected page structure:
 *   - Match rows: `table.matches tr`, `table tr.match`, `div.match-row`
 *   - Player names: `td.player1, td.player2`, `a[href*="/player/"]`
 *   - Win probability: `td.prob, td.winprob`, percentage text in cells
 *   - Tournament info: `h2, h3, .tournament-name, .event-name`
 *   - Match time: `td.time, td.start-time, .match-time`
 */
export class TennisAbstractAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'tennisabstract',
    name: 'Tennis Abstract',
    baseUrl: 'https://www.tennisabstract.com',
    fetchMethod: 'http',
    paths: {
      tennis: '/current/',
    },
    cron: '0 0 6,14,20 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const todayStr = fetchedAt.toISOString().split('T')[0]!;
    let currentTournament = '';

    // Try to extract tournament name from headers
    $('h2, h3, .tournament-name, .event-name, .tourney-name').each((_i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 2 && text.length < 100) {
        currentTournament = text;
      }
    });

    // Parse match rows from tables
    $('table.matches tr, table.current tr, table tr.match, div.match-row, .match-container, table tbody tr').each((_i, el) => {
      const $row = $(el);
      const cells = $row.find('td');
      if (cells.length < 2) return;

      // Extract player names - try multiple approaches
      let player1 = '';
      let player2 = '';

      // Approach 1: Named cells
      const p1Cell = $row.find('td.player1, td.p1, td:nth-child(1) a, .player-home, .player-name:first');
      const p2Cell = $row.find('td.player2, td.p2, td:nth-child(3) a, .player-away, .player-name:last');
      if (p1Cell.length && p2Cell.length) {
        player1 = p1Cell.text().trim();
        player2 = p2Cell.text().trim();
      }

      // Approach 2: Links to player pages
      if (!player1 || !player2) {
        const playerLinks = $row.find('a[href*="player"], a[href*="cgi-bin"]');
        if (playerLinks.length >= 2) {
          player1 = $(playerLinks[0]).text().trim();
          player2 = $(playerLinks[1]).text().trim();
        }
      }

      // Approach 3: First two text-heavy cells
      if (!player1 || !player2) {
        const textCells: string[] = [];
        cells.each((_j, cell) => {
          const t = $(cell).text().trim();
          if (t.length > 2 && !/^\d+(\.\d+)?%?$/.test(t)) {
            textCells.push(t);
          }
        });
        if (textCells.length >= 2) {
          player1 = textCells[0]!;
          player2 = textCells[1]!;
        }
      }

      if (!player1 || !player2) return;

      // Extract win probability
      let p1Prob = 0;
      let p2Prob = 0;
      $row.find('td.prob, td.winprob, td.win-probability, td').each((_j, cell) => {
        const text = $(cell).text().trim();
        const pctMatch = text.match(/(\d{1,3}(?:\.\d+)?)%/);
        if (pctMatch) {
          const pct = parseFloat(pctMatch[1]!);
          if (pct > 0 && pct <= 100) {
            if (p1Prob === 0) p1Prob = pct;
            else if (p2Prob === 0) p2Prob = pct;
          }
        }
      });

      // Extract time
      const timeText = $row.find('td.time, td.start-time, .match-time').text().trim();
      const timeMatch = timeText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)/);
      const gameTime = timeMatch ? timeMatch[1]! : null;

      // Determine side based on win probability
      let side: Side = 'home';
      if (p1Prob > 0 && p2Prob > 0) {
        side = p1Prob >= p2Prob ? 'home' : 'away';
      }

      const maxProb = Math.max(p1Prob, p2Prob);
      const confidence = maxProb >= 80 ? 'best_bet' as const
        : maxProb >= 65 ? 'high' as const
        : maxProb >= 50 ? 'medium' as const
        : maxProb > 0 ? 'low' as const
        : null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate: todayStr,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'Tennis Abstract',
        confidence,
        reasoning: [
          currentTournament || null,
          maxProb > 0 ? `Win prob: ${p1Prob}%-${p2Prob}%` : null,
        ].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    return predictions;
  }
}
