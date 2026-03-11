import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * HotStreak NBA adapter.
 *
 * STATUS: URL returns 404 via Webflow hosting. The site/path
 * no longer exists at hotstreak.gg. Check for updated URL.
 *
 * HotStreak.gg provides NBA picks with confidence ratings
 * and win probability estimates.
 *
 * Page structure:
 * - `.game-card, .matchup-card`: game prediction container
 * - `.team-away, .team-home`: team name elements
 * - `.pick-badge, .recommended-pick`: the pick indicator
 * - `.confidence-rating, .win-prob`: confidence level or win probability
 * - `.pick-type-label`: spread/ML/total label
 * - `.pick-value`: the specific pick value
 * - `.game-meta .date, .game-time`: date and time info
 * - `.streak-info`: picker's hot/cold streak info
 */
export class HotstreakNbaAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'hotstreak-nba',
    name: 'HotStreak NBA',
    baseUrl: 'https://hotstreak.gg',
    fetchMethod: 'http',
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
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    $('.game-card, .matchup-card, .pick-card, .prediction-row').each((_i, el) => {
      const $card = $(el);

      // Extract teams
      const awayTeamRaw = $card.find('.team-away, .away-team, .away .team-name').text().trim();
      const homeTeamRaw = $card.find('.team-home, .home-team, .home .team-name').text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      // Date/time
      const dateText = $card.find('.game-meta .date, .game-date, time').text().trim();
      const gameDate = this.extractDate(dateText) || todayStr;
      const gameTime = $card.find('.game-time, .tip-off').text().trim() || null;

      // Confidence/win probability
      const confText = $card.find('.confidence-rating, .win-prob, .confidence').text().trim();
      const confidence = this.parseConfidence(confText);

      // Streak info for reasoning
      const streakInfo = $card.find('.streak-info, .record').text().trim();

      // Parse individual pick types within the card
      $card.find('.pick-item, .pick-detail, .bet-type-row').each((_j, pickEl) => {
        const $pick = $(pickEl);
        const typeLabel = $pick.find('.pick-type-label, .type-label').text().trim();
        const valueText = $pick.find('.pick-value, .value').text().trim();
        const isRecommended = $pick.find('.pick-badge, .recommended-pick, .hot-pick').length > 0
          || $pick.hasClass('recommended');

        const pickType = this.inferPickType(typeLabel || valueText);
        let side: Side;
        let value: number | null = null;

        if (pickType === 'over_under') {
          side = valueText.toLowerCase().includes('under') ? 'under' : 'over';
          value = this.parseTotalValue(valueText);
        } else if (pickType === 'spread') {
          value = this.parseSpreadValue(valueText);
          side = this.resolveTeamSide(valueText, awayTeamRaw, homeTeamRaw);
        } else {
          side = this.resolveTeamSide(valueText, awayTeamRaw, homeTeamRaw);
        }

        const pickConf = isRecommended ? 'best_bet' as const : confidence;

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
          pickerName: 'HotStreak',
          confidence: pickConf,
          reasoning: [
            valueText,
            streakInfo ? `Streak: ${streakInfo}` : '',
          ].filter(Boolean).join(' | ').slice(0, 300) || null,
          fetchedAt,
        });
      });

      // If no individual pick items, create default moneyline pick
      if ($card.find('.pick-item, .pick-detail, .bet-type-row').length === 0) {
        const mainPick = $card.find('.pick-badge, .recommended-pick, .pick, .winner').text().trim();
        const side = this.resolveTeamSide(mainPick, awayTeamRaw, homeTeamRaw);

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
          pickerName: 'HotStreak',
          confidence,
          reasoning: [
            mainPick,
            streakInfo ? `Streak: ${streakInfo}` : '',
          ].filter(Boolean).join(' | ').slice(0, 300) || null,
          fetchedAt,
        });
      }
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

  /** Parse confidence from percentage, descriptive text, or rating. */
  private parseConfidence(text: string): 'low' | 'medium' | 'high' | 'best_bet' | null {
    if (!text) return null;
    const pctMatch = text.match(/(\d+)\s*%/);
    if (pctMatch) {
      const pct = parseInt(pctMatch[1]!, 10);
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
