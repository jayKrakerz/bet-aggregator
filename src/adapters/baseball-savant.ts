import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Baseball Savant adapter.
 *
 * STATUS: FIXED - /scoreboard is a SPA that renders game data via React.
 * With browser fetch, the page renders #scoreboard containing .game divs,
 * each with a <table> showing teams (in td.team-meta > div.team) with
 * records, game times, and probable pitchers.
 *
 * Note: No win probabilities are shown in the HTML. We derive a basic
 * prediction from team W-L records using the log5 method.
 *
 * DOM structure (as of 2026-03-10):
 * - `#scoreboard .game` containers per matchup
 * - Each .game has a `<table>` with:
 *   - `thead > tr > th`: game time (e.g. "5:05 PM")
 *   - `tbody > tr:first td.team-meta .team`: away team + record
 *   - `tbody > tr:nth(1) td.team-meta .team`: home team + record
 *   - Nested table with "Probable Pitchers" and pitcher names
 * - `var date = 'YYYY-MM-DD'` in a script tag for the scoreboard date
 */
export class BaseballSavantAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'baseball-savant',
    name: 'Baseball Savant',
    baseUrl: 'https://baseballsavant.mlb.com',
    fetchMethod: 'browser',
    paths: {
      mlb: '/scoreboard',
    },
    cron: '0 0 10,14,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Extract date from script var or fall back to fetchedAt
    let today = fetchedAt.toISOString().split('T')[0]!;
    $('script').each((_i, el) => {
      const text = $(el).html() || '';
      const dateMatch = text.match(/var\s+date\s*=\s*'(\d{4}-\d{2}-\d{2})'/);
      if (dateMatch) today = dateMatch[1]!;
    });

    // The scoreboard page renders inside #scoreboard as:
    //   #scoreboard > div > div > div.scores > div.game
    // Each .game contains a <table> with:
    //   - thead > tr > th[0]: game time (e.g. "5:05 PM")
    //   - tbody > tr.border-top (first team = away):
    //       td.team-meta > div > div.team = "Yankees (10-6)"
    //   - tbody > tr (second team = home):
    //       td.team-meta > div > div.team = "Phillies (5-10)"
    //   - Probable pitchers in a nested table with pitcher names
    // No win probabilities in the HTML — we derive predictions from W-L records.
    $('#scoreboard .game').each((_i, el) => {
      const $game = $(el);

      // Game time from the first <th> in the thead
      const gameTime = $game.find('thead th').first().text().trim() || null;

      // Team names from .team-meta .team — first is away, second is home
      const teamDivs = $game.find('td.team-meta .team');
      if (teamDivs.length < 2) return;

      const awayRaw = $(teamDivs[0]).text().trim(); // e.g. "Yankees (10-6)"
      const homeRaw = $(teamDivs[1]).text().trim(); // e.g. "Phillies (5-10)"

      const awayTeamRaw = awayRaw.replace(/\s*\([\d-]+\)\s*$/, '').trim();
      const homeTeamRaw = homeRaw.replace(/\s*\([\d-]+\)\s*$/, '').trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Extract W-L records to derive a basic win expectation
      const awayRecord = awayRaw.match(/\((\d+)-(\d+)\)/);
      const homeRecord = homeRaw.match(/\((\d+)-(\d+)\)/);
      let awayWinPct = 0.5;
      let homeWinPct = 0.5;
      if (awayRecord) {
        const w = parseInt(awayRecord[1]!, 10);
        const l = parseInt(awayRecord[2]!, 10);
        awayWinPct = (w + l) > 0 ? w / (w + l) : 0.5;
      }
      if (homeRecord) {
        const w = parseInt(homeRecord[1]!, 10);
        const l = parseInt(homeRecord[2]!, 10);
        homeWinPct = (w + l) > 0 ? w / (w + l) : 0.5;
      }

      // Normalize to probabilities (log5 method)
      const awayProb = (awayWinPct * (1 - homeWinPct)) /
        (awayWinPct * (1 - homeWinPct) + homeWinPct * (1 - awayWinPct)) || 0.5;
      const homeProb = 1 - awayProb;

      // Extract probable pitchers from nested table
      const pitcherNames: string[] = [];
      $game.find('table table .player-mug').each((_j, img) => {
        const name = $(img).parent().text().trim();
        if (name) pitcherNames.push(name);
      });
      // Fallback: just grab text nodes near pitcher mug images
      if (pitcherNames.length === 0) {
        $game.find('table table td[colspan] div div').each((_j, div) => {
          const text = $(div).text().trim();
          if (text && text !== 'Probable Pitchers' && !text.includes('Probable') && !text.includes('Preview') && !text.includes('Gamefeed')) {
            pitcherNames.push(text);
          }
        });
      }

      const side: Side = homeProb >= awayProb ? 'home' : 'away';
      const winProb = Math.max(homeProb, awayProb) * 100;
      const confidence = winProb >= 62 ? 'high' as const
        : winProb >= 54 ? 'medium' as const
        : 'low' as const;

      const pitcherInfo = pitcherNames.length >= 2
        ? `SP: ${pitcherNames[0]} vs ${pitcherNames[1]}`
        : pitcherNames.length === 1 ? `SP: ${pitcherNames[0]}` : '';
      const reasoning = [
        `Record-based: ${awayTeamRaw} ${(awayProb * 100).toFixed(0)}% / ${homeTeamRaw} ${(homeProb * 100).toFixed(0)}%`,
        pitcherInfo,
      ].filter(Boolean).join(' | ');

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate: today,
        gameTime,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'Baseball Savant',
        confidence,
        reasoning,
        fetchedAt,
      });
    });

    return predictions;
  }
}
