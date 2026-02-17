import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Vitibet adapter.
 *
 * Static HTML site with two prediction sections:
 *
 * 1. TOP tips (`.container-tips .tip-box`):
 *    - `.match-header`: "⚽ Girona vs Barcelona (La Liga, Spain)"
 *    - `.tip-body > strong`: "Prediction: Barcelona"
 *    - `.tip-reason`: AI reasoning text
 *
 * 2. Traditional table (`.tabulkaquick`):
 *    - League rows: `.odseknutiligy` with country + league text
 *    - Match rows: `td.standardbunka` cells with date, teams, score, probabilities
 *    - Prediction: `td[class^="barvapodtipek"]` with "1" (home), "2" (away), "10"/"02" (double)
 *    - Probabilities: `td.standardbunkaprocenta` (home%, draw%, away%)
 *    - Predicted score: `td.vetsipismo` cells
 */
export class VitibetAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'vitibet',
    name: 'Vitibet',
    baseUrl: 'https://www.vitibet.com',
    fetchMethod: 'http',
    paths: {
      football: '/index.php?clanek=quicktips&sekce=fotbal&lang=en',
      nba: '/index.php?clanek=quicktips&sekce=basket&lang=en',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    // Parse both sections
    predictions.push(...this.parseTopTips(html, sport, fetchedAt));
    predictions.push(...this.parseTable(html, sport, fetchedAt));

    return predictions;
  }

  /**
   * Parse the "TOP tips" section with AI-generated reasoning.
   */
  private parseTopTips(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('.container-tips .tip-box').each((_i, el) => {
      const $box = $(el);

      // Parse match header: "⚽ Girona vs Barcelona (La Liga, Spain)"
      const headerText = $box.find('.match-header').text().trim();
      const matchInfo = this.parseMatchHeader(headerText);
      if (!matchInfo) return;

      // Parse prediction: <strong>Prediction:</strong> TeamName
      const tipBodyText = $box.find('.tip-body').text().trim();
      const predMatch = tipBodyText.match(/Prediction:\s*(.+?)(?:\s*▼|$)/);
      if (!predMatch) return;

      const predictedTeam = predMatch[1]!.trim();
      const side = this.resolveTeamSide(predictedTeam, matchInfo.home, matchInfo.away);

      // Get reasoning
      const reasoning = $box.find('.tip-reason').text().trim().slice(0, 500) || null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchInfo.home,
        awayTeamRaw: matchInfo.away,
        gameDate: fetchedAt.toISOString().split('T')[0]!,
        gameTime: null,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'Vitibet AI',
        confidence: 'high',
        reasoning: reasoning ? `${matchInfo.league} | ${reasoning.slice(0, 300)}` : matchInfo.league,
        fetchedAt,
      });
    });

    return predictions;
  }

  /**
   * Parse the traditional `.tabulkaquick` table with probabilities and scores.
   */
  private parseTable(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentLeague = '';

    $('table.tabulkaquick tr').each((_i, el) => {
      const $row = $(el);

      // League header rows
      if ($row.hasClass('odseknutiligy')) {
        currentLeague = $row.text().trim();
        return;
      }

      // Match rows have standardbunka cells
      const cells = $row.find('td');
      if (cells.length < 10) return;

      // Extract teams from standardbunka cells (skip date and logo cells)
      const teamCells = cells.filter((_j, cell) => {
        const cls = $(cell).attr('class') || '';
        return cls === 'standardbunka';
      });

      // Find team names — text cells that aren't dates, colons, or empty
      const teamNames: string[] = [];
      teamCells.each((_j, cell) => {
        const text = $(cell).text().trim();
        if (text && text !== ':' && !/^\d{1,2}\.\d{1,2}$/.test(text) && text.length > 1) {
          teamNames.push(text);
        }
      });

      if (teamNames.length < 2) return;
      const homeTeamRaw = teamNames[0]!;
      const awayTeamRaw = teamNames[1]!;

      // Extract predicted score from vetsipismo cells
      const scoreCells: string[] = [];
      cells.filter((_j, cell) => $(cell).hasClass('vetsipismo')).each((_j, cell) => {
        scoreCells.push($(cell).text().trim());
      });
      const scorePred = scoreCells.length >= 2 ? `${scoreCells[0]}-${scoreCells[1]}` : null;

      // Extract tip from barvapodtipek* class
      const tipCell = cells.filter((_j, cell) => {
        const cls = $(cell).attr('class') || '';
        return cls.startsWith('barvapodtipek');
      });
      const tipText = tipCell.first().text().trim();
      const side = this.mapTipToSide(tipText);
      if (!side) return;

      // Extract probabilities from standardbunkaprocenta cells
      const probs: number[] = [];
      cells.filter((_j, cell) => $(cell).hasClass('standardbunkaprocenta')).each((_j, cell) => {
        const text = $(cell).text().trim().replace(/%.*/, '').trim();
        const val = parseInt(text, 10);
        if (!isNaN(val) && val >= 0 && val <= 100) probs.push(val);
      });

      const confidence = this.probsToConfidence(probs, side);

      // Extract date
      const dateCell = cells.first().text().trim();
      const dateMatch = dateCell.match(/(\d{1,2})\.(\d{1,2})/);
      let gameDate = fetchedAt.toISOString().split('T')[0]!;
      if (dateMatch) {
        const year = fetchedAt.getFullYear();
        const day = dateMatch[1]!.padStart(2, '0');
        const month = dateMatch[2]!.padStart(2, '0');
        gameDate = `${year}-${month}-${day}`;
      }

      const reasoning = [
        currentLeague,
        scorePred ? `Predicted: ${scorePred}` : '',
        probs.length >= 3 ? `Prob: ${probs[0]}/${probs[1]}/${probs[2]}` : '',
      ].filter(Boolean).join(' | ') || null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate,
        gameTime: null,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'Vitibet',
        confidence,
        reasoning,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseMatchHeader(text: string): { home: string; away: string; league: string } | null {
    // "⚽ Girona vs Barcelona (La Liga, Spain)"
    const cleaned = text.replace(/^[⚽🏀🏈\s]+/, '').trim();
    const match = cleaned.match(/^(.+?)\s+vs\s+(.+?)\s*\((.+)\)\s*$/);
    if (!match) return null;
    return { home: match[1]!.trim(), away: match[2]!.trim(), league: match[3]!.trim() };
  }

  private resolveTeamSide(predicted: string, home: string, away: string): Side {
    const pLower = predicted.toLowerCase();
    const hLower = home.toLowerCase();
    const aLower = away.toLowerCase();
    if (pLower.includes('draw')) return 'draw';
    if (pLower === hLower || hLower.includes(pLower) || pLower.includes(hLower)) return 'home';
    if (pLower === aLower || aLower.includes(pLower) || pLower.includes(aLower)) return 'away';
    return 'home';
  }

  private mapTipToSide(tip: string): Side | null {
    if (tip === '1') return 'home';
    if (tip === '2') return 'away';
    if (tip === 'X' || tip === 'x' || tip === '0') return 'draw';
    // Double chance: "10" = home or draw, "02" = draw or away
    if (tip === '10' || tip === '1X' || tip === '1x') return 'home';
    if (tip === '02' || tip === 'X2' || tip === 'x2') return 'away';
    return null;
  }

  private probsToConfidence(probs: number[], side: Side): Confidence | null {
    if (probs.length < 3) return null;
    let prob: number;
    if (side === 'home') prob = probs[0]!;
    else if (side === 'draw') prob = probs[1]!;
    else prob = probs[2]!;

    if (prob >= 70) return 'best_bet';
    if (prob >= 55) return 'high';
    if (prob >= 40) return 'medium';
    return 'low';
  }
}
