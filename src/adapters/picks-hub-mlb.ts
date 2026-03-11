import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Picks Hub MLB adapter.
 *
 * Scrapes free MLB picks from pickshub.net/mlb.
 * A simple picks aggregation site with straightforward HTML:
 *
 * - `.pick-card, .game-pick` containers per matchup
 * - `.pick-card__teams` with "Away vs Home" text
 * - `.pick-card__selection` for the recommended pick
 * - `.pick-card__odds` for odds value
 * - `.pick-card__confidence` for confidence level
 * - `.pick-card__date` for game date
 * - `.pick-card__analysis` for brief analysis text
 */
export class PicksHubMlbAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'picks-hub-mlb',
    name: 'Picks Hub MLB',
    baseUrl: 'https://pickshub.net',
    fetchMethod: 'http',
    paths: {
      mlb: '/mlb/',
    },
    cron: '0 0 8,12,16 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    $('.pick-card, .game-pick, .prediction-box, article.pick').each((_i, el) => {
      const $card = $(el);

      // Team names from matchup text
      const matchupText = $card.find('.pick-card__teams, .matchup, .teams, h3, h2').first().text().trim();
      const teams = this.parseMatchup(matchupText);
      if (!teams) return;

      // Pick selection
      const pickText = $card.find('.pick-card__selection, .pick, .selection, strong').first().text().trim();
      if (!pickText) return;

      const pickType = this.inferPickType(pickText);
      const side = this.resolveSide(pickText, teams.home, teams.away);

      // Value
      let value: number | null = null;
      const oddsText = $card.find('.pick-card__odds, .odds, .line').text().trim();
      if (pickType === 'moneyline') {
        value = this.parseMoneylineValue(oddsText);
      } else if (pickType === 'spread') {
        value = this.parseSpreadValue(oddsText);
      } else if (pickType === 'over_under') {
        value = this.parseTotalValue(oddsText);
      }

      // Confidence
      const confText = $card.find('.pick-card__confidence, .confidence, .rating').text().trim();
      const confidence = this.inferConfidence(confText);

      // Date
      const dateText = $card.find('.pick-card__date, .date, .game-date').text().trim();
      const gameDate = this.extractDate(dateText) || today;

      // Game time
      const gameTime = $card.find('.game-time, .time').text().trim() || null;

      // Analysis
      const reasoning = $card.find('.pick-card__analysis, .analysis, .reason, p').first().text().trim().slice(0, 300) || null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: teams.home,
        awayTeamRaw: teams.away,
        gameDate,
        gameTime,
        pickType,
        side,
        value,
        pickerName: 'Picks Hub',
        confidence,
        reasoning,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseMatchup(text: string): { home: string; away: string } | null {
    const match = text.match(/^(.+?)\s+(?:vs\.?|@|at)\s+(.+?)$/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
  }

  private resolveSide(pick: string, home: string, away: string): Side {
    const pLower = pick.toLowerCase();
    if (pLower.includes('over')) return 'over';
    if (pLower.includes('under')) return 'under';
    const hLower = home.toLowerCase();
    const aLower = away.toLowerCase();
    if (pLower.includes(hLower) || hLower.includes(pLower)) return 'home';
    if (pLower.includes(aLower) || aLower.includes(pLower)) return 'away';
    return 'home';
  }

  private extractDate(text: string): string | null {
    const isoMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1]!;
    const usMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (usMatch) {
      return `${usMatch[3]}-${usMatch[1]!.padStart(2, '0')}-${usMatch[2]!.padStart(2, '0')}`;
    }
    return null;
  }
}
