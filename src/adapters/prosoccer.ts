import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * ProSoccer.gr adapter.
 *
 * Static HTML site using jQuery DataTables. Predictions are in tables
 * with IDs #tblDay1 through #tblDay7 (one per day).
 *
 * Columns: League | UTC | Match | Prob% 1 | Prob% X | Prob% 2 | Tips |
 *          Odds 1 | Odds X | Odds 2 | Pred. Score 1 | Pred. Score 2 |
 *          Under 2.5 | Over 2.5 | Final Score
 *
 * Tips codes: a1=home, a2=away, aX=draw, a1X=home/draw, a2X=away/draw,
 *             a12=home/away, a21=away/home
 */
export class ProSoccerAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'prosoccer',
    name: 'ProSoccer.gr',
    baseUrl: 'https://www.prosoccer.gr',
    fetchMethod: 'http',
    paths: {
      football: '/en/football/predictions/',
    },
    cron: '0 0 7,12,18 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Single table with id="tblPredictions" (jQuery DataTables)
    const table = $('#tblPredictions');
    if (!table.length) return predictions;

    table.find('tbody tr').each((_i, el) => {
      const $row = $(el);
      const cells = $row.find('td');
      if (cells.length < 10) return;

      // Column mapping based on actual DOM:
      // 0: League (td.fc9), 1: Time (td.fc7 > small), 2: Match (td.mio.fc1)
      // 3-5: Prob% 1/X/2 (td[class^="pu"]), 6: Tip (span.sctip), 7-9: Odds (td[class^="ou"])
      // 10-11: Pred Score, 12-13: Under/Over 2.5, 14: Final Score
      const leagueCell = $(cells[0]);
      const league = leagueCell.text().trim().replace(/\n/g, ' ');
      const time = $(cells[1]).find('small').text().trim() || $(cells[1]).text().trim();

      // Teams: "HOME - AWAY" in td.mio.fc1 — &nbsp; separates
      const matchText = $(cells[2]).text().trim().replace(/\u00a0/g, ' ');
      const prob1 = parseInt($(cells[3]).text().trim(), 10);
      const probX = parseInt($(cells[4]).text().trim(), 10);
      const prob2 = parseInt($(cells[5]).text().trim(), 10);

      // Tip from span.sctip inside the tip cell
      const tip = $(cells[6]).find('span.sctip').text().trim() || $(cells[6]).text().trim();
      const odds1 = $(cells[7]).text().trim();
      const oddsX = $(cells[8]).text().trim();
      const odds2 = $(cells[9]).text().trim();

      const predScore1 = cells.length > 10 ? $(cells[10]).text().trim() : '';
      const predScore2 = cells.length > 11 ? $(cells[11]).text().trim() : '';
      const under25 = cells.length > 12 ? $(cells[12]).text().trim() : '';
      const over25 = cells.length > 13 ? $(cells[13]).text().trim() : '';

      const teams = this.parseMatchTeams(matchText);
      if (!teams) return;

      const side = this.mapTipToSide(tip);
      if (!side) return;

      const confidence = this.probsToConfidence(prob1, probX, prob2, side);
      const gameDate = fetchedAt.toISOString().split('T')[0]!;

      const reasoning = [
        league,
        `Prob: ${prob1}/${probX}/${prob2}`,
        `Odds: ${odds1}/${oddsX}/${odds2}`,
        predScore1 && predScore2 ? `Predicted: ${predScore1}-${predScore2}` : '',
        over25 ? `O2.5: ${over25}%` : '',
      ].filter(Boolean).join(' | ');

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: teams.home,
        awayTeamRaw: teams.away,
        gameDate,
        gameTime: time || null,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'ProSoccer Neural Net',
        confidence,
        reasoning,
        fetchedAt,
      });

      // Add over/under prediction if data is available
      if (over25 && under25) {
        const overPct = parseInt(over25, 10);
        const underPct = parseInt(under25, 10);
        if (!isNaN(overPct) && !isNaN(underPct) && Math.abs(overPct - underPct) >= 10) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: teams.home,
            awayTeamRaw: teams.away,
            gameDate,
            gameTime: time || null,
            pickType: 'over_under',
            side: overPct > underPct ? 'over' : 'under',
            value: 2.5,
            pickerName: 'ProSoccer Neural Net',
            confidence: this.ouConfidence(overPct, underPct),
            reasoning: `${league} | O2.5: ${overPct}%, U2.5: ${underPct}%`,
            fetchedAt,
          });
        }
      }
    });

    return predictions;
  }

  private parseMatchTeams(text: string): { home: string; away: string } | null {
    // "BARNSLEY - WYCOMBE" or "Team A - Team B"
    const parts = text.split(/\s*-\s*/);
    if (parts.length < 2) return null;
    const home = parts[0]!.trim();
    const away = parts.slice(1).join('-').trim();
    if (!home || !away) return null;
    return { home, away };
  }

  private mapTipToSide(tip: string): Side | null {
    const code = tip.toLowerCase().replace(/^a/, '');
    if (code === '1') return 'home';
    if (code === '2') return 'away';
    if (code === 'x') return 'draw';
    if (code === '1x' || code === '10') return 'home';
    if (code === '2x' || code === 'x2' || code === '02') return 'away';
    if (code === '12' || code === '21') return 'home';
    return null;
  }

  private probsToConfidence(p1: number, pX: number, p2: number, side: Side): Confidence | null {
    if (isNaN(p1) || isNaN(pX) || isNaN(p2)) return null;
    let prob: number;
    if (side === 'home') prob = p1;
    else if (side === 'draw') prob = pX;
    else prob = p2;

    if (prob >= 70) return 'best_bet';
    if (prob >= 55) return 'high';
    if (prob >= 40) return 'medium';
    return 'low';
  }

  private ouConfidence(overPct: number, underPct: number): Confidence {
    const diff = Math.abs(overPct - underPct);
    if (diff >= 40) return 'best_bet';
    if (diff >= 25) return 'high';
    if (diff >= 15) return 'medium';
    return 'low';
  }

}
