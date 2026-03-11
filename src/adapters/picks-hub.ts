import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * PicksHub adapter.
 *
 * PicksHub.net provides free NBA picks including spread,
 * moneyline, and over/under predictions with confidence ratings.
 *
 * Page structure:
 * - `.pick-card, .game-pick`: individual pick container
 * - `.matchup .team`: team names (away, home)
 * - `.pick-type`: spread/ML/total label
 * - `.pick-selection`: the actual pick (team name + value)
 * - `.confidence-bar, .confidence`: confidence percentage or bar
 * - `.game-info .date`: game date
 * - `.analysis`: brief pick analysis
 */
export class PicksHubAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'picks-hub',
    name: 'PicksHub',
    baseUrl: 'https://pickshub.net',
    fetchMethod: 'http',
    paths: {
      nba: '/nba/',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    $('.pick-card, .game-pick, .prediction-card, .picks-item').each((_i, el) => {
      const $card = $(el);

      // Extract teams
      const teamEls = $card.find('.matchup .team, .team-name, .team-info');
      let awayTeamRaw = '';
      let homeTeamRaw = '';

      if (teamEls.length >= 2) {
        awayTeamRaw = $(teamEls[0]).text().trim();
        homeTeamRaw = $(teamEls[1]).text().trim();
      } else {
        const matchText = $card.find('.matchup, .game-title, h3').text().trim();
        const vsMatch = matchText.match(/^(.+?)\s+(?:vs\.?|@|at)\s+(.+?)$/i);
        if (vsMatch) {
          awayTeamRaw = vsMatch[1]!.trim();
          homeTeamRaw = vsMatch[2]!.trim();
        }
      }
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Date
      const dateText = $card.find('.date, .game-date, time').text().trim();
      const gameDate = this.extractDate(dateText) || todayStr;

      // Pick type and selection
      const typeText = $card.find('.pick-type, .bet-type').text().trim();
      const selectionText = $card.find('.pick-selection, .pick-value, .selection').text().trim();
      const pickType = this.inferPickType(typeText || selectionText);

      let side: Side;
      let value: number | null = null;

      if (pickType === 'over_under') {
        side = selectionText.toLowerCase().includes('under') ? 'under' : 'over';
        value = this.parseTotalValue(selectionText);
      } else if (pickType === 'spread') {
        value = this.parseSpreadValue(selectionText);
        side = this.resolveTeamSide(selectionText, awayTeamRaw, homeTeamRaw);
      } else {
        side = this.resolveTeamSide(selectionText, awayTeamRaw, homeTeamRaw);
      }

      // Confidence
      const confText = $card.find('.confidence-bar, .confidence, .conf-pct').text().trim();
      const confidence = this.parseConfPercent(confText);

      // Analysis
      const analysis = $card.find('.analysis, .pick-reason, .description').text().trim();

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate,
        gameTime: null,
        pickType,
        side,
        value,
        pickerName: 'PicksHub',
        confidence,
        reasoning: analysis ? analysis.slice(0, 300) : null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private resolveTeamSide(text: string, away: string, home: string): Side {
    const lower = text.toLowerCase();
    const awayLast = away.toLowerCase().split(' ').pop()!;
    const homeLast = home.toLowerCase().split(' ').pop()!;
    if (lower.includes(awayLast)) return 'away';
    if (lower.includes(homeLast)) return 'home';
    return 'home';
  }

  /** Parse confidence from percentage text (e.g., "72%", "85% confidence"). */
  private parseConfPercent(text: string): 'low' | 'medium' | 'high' | 'best_bet' | null {
    if (!text) return null;
    const match = text.match(/(\d+)\s*%/);
    if (match) {
      const pct = parseInt(match[1]!, 10);
      if (pct >= 80) return 'best_bet';
      if (pct >= 65) return 'high';
      if (pct >= 50) return 'medium';
      return 'low';
    }
    return this.inferConfidence(text);
  }

  private extractDate(text: string): string | null {
    const match = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (!match) return null;
    const month = match[1]!.padStart(2, '0');
    const day = match[2]!.padStart(2, '0');
    const year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : String(new Date().getFullYear());
    return `${year}-${month}-${day}`;
  }
}
