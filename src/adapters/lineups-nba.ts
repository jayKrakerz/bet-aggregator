import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Lineups.com NBA adapter.
 *
 * Lineups.com provides NBA game predictions, projected lineups,
 * and betting picks with spread and total recommendations.
 *
 * STATUS: Site is behind Cloudflare challenge. Changed to browser
 * fetch to attempt bypassing the JS challenge.
 *
 * Page structure:
 * - `.matchup-container, .game-matchup`: game container
 * - `.team-info .team-name`: team names
 * - `.prediction-value`: spread/moneyline/total pick
 * - `.pick-label`: type label (Spread, Total, ML)
 * - `.game-date`: date of the game
 * - `.confidence-badge`: confidence indicator
 */
export class LineupsNbaAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'lineups-nba',
    name: 'Lineups.com NBA',
    baseUrl: 'https://www.lineups.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/nba/picks',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Try primary selectors
    $('.matchup-container, .game-matchup, .picks-card').each((_i, el) => {
      const $card = $(el);

      const teamEls = $card.find('.team-name, .team-info__name');
      if (teamEls.length < 2) return;
      const awayTeamRaw = $(teamEls[0]).text().trim();
      const homeTeamRaw = $(teamEls[1]).text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      const dateText = $card.find('.game-date, .matchup-date, time').text().trim();
      const gameDate = this.extractDate(dateText, fetchedAt);
      const gameTime = $card.find('.game-time, .matchup-time').text().trim() || null;

      // Iterate over pick sections within each matchup
      $card.find('.pick-section, .prediction-item, .pick-row').each((_j, pickEl) => {
        const $pick = $(pickEl);
        const labelText = $pick.find('.pick-label, .pick-type').text().trim();
        const valueText = $pick.find('.prediction-value, .pick-value').text().trim();
        const confText = $pick.find('.confidence-badge, .confidence').text().trim();

        const pickType = this.inferPickType(labelText || valueText);

        let side: Side;
        let value: number | null = null;

        if (pickType === 'over_under') {
          side = valueText.toLowerCase().includes('under') ? 'under' : 'over';
          value = this.parseTotalValue(valueText);
        } else if (pickType === 'spread') {
          value = this.parseSpreadValue(valueText);
          // Negative spread means that team is favored
          const pickTeam = $pick.find('.picked-team, .pick-team').text().trim();
          side = pickTeam.toLowerCase().includes(awayTeamRaw.toLowerCase().split(' ').pop()!) ? 'away' : 'home';
        } else {
          const pickTeam = $pick.find('.picked-team, .pick-team').text().trim();
          side = pickTeam.toLowerCase().includes(awayTeamRaw.toLowerCase().split(' ').pop()!) ? 'away' : 'home';
          value = this.parseMoneylineValue(valueText);
        }

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType,
          side,
          value,
          pickerName: 'Lineups.com',
          confidence: this.inferConfidence(confText),
          reasoning: labelText ? `${labelText}: ${valueText}` : valueText || null,
          fetchedAt,
        });
      });

      // If no individual pick sections found, create a default moneyline pick
      if ($card.find('.pick-section, .prediction-item, .pick-row').length === 0) {
        const pickText = $card.find('.prediction, .pick-text, .winner').text().trim();
        const side: Side = pickText.toLowerCase().includes(awayTeamRaw.toLowerCase().split(' ').pop()!) ? 'away' : 'home';

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'Lineups.com',
          confidence: null,
          reasoning: pickText || null,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private extractDate(text: string, fetchedAt: Date): string {
    const match = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (match) {
      const month = match[1]!.padStart(2, '0');
      const day = match[2]!.padStart(2, '0');
      const year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : String(fetchedAt.getFullYear());
      return `${year}-${month}-${day}`;
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
