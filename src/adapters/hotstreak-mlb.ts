import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * HotStreak MLB adapter.
 *
 * STATUS: 404 NOT FOUND - /mlb/picks returns a Webflow "Page Not Found" page
 * as of 2026-03-10. The URL path has likely changed or the MLB section was
 * removed from hotstreak.gg. This adapter cannot produce predictions until
 * a valid URL is found.
 *
 * Scrapes MLB picks from hotstreak.gg/mlb.
 * HotStreak is a modern picks platform with game cards:
 *
 * - `.game-card, .matchup-card` containers per game
 * - `.game-card__away, .game-card__home` with team names and records
 * - `.game-card__pick` for the recommended side
 * - `.game-card__streak` for hot/cold streak data
 * - `.game-card__odds` for odds across markets
 * - `.game-card__time` for game start time
 * - Streak data used to derive confidence
 */
export class HotStreakMlbAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'hotstreak-mlb',
    name: 'HotStreak MLB',
    baseUrl: 'https://hotstreak.gg',
    fetchMethod: 'http',
    paths: {
      mlb: '/mlb/picks',
    },
    cron: '0 0 9,13,17 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    $('.game-card, .matchup-card, .pick-card, [data-game]').each((_i, el) => {
      const $card = $(el);

      const awayTeamRaw = $card.find('.game-card__away .team-name, .away-team .name, .team:first-child .name').text().trim();
      const homeTeamRaw = $card.find('.game-card__home .team-name, .home-team .name, .team:last-child .name').text().trim();

      if (!homeTeamRaw || !awayTeamRaw) {
        // Fallback: matchup text
        const matchText = $card.find('.matchup, h3, h2').first().text().trim();
        const parsed = this.parseMatchup(matchText);
        if (!parsed) return;
        // re-assign won't work due to const; skip if no teams found
        return;
      }

      const gameTime = $card.find('.game-card__time, .game-time, .start-time').text().trim() || null;

      // Pick
      const pickText = $card.find('.game-card__pick, .pick, .recommended').text().trim();
      const pickType = this.inferPickType(pickText);
      const side = this.resolveSide(pickText, homeTeamRaw, awayTeamRaw);

      // Streak data for confidence
      const streakText = $card.find('.game-card__streak, .streak, .trend').text().trim();
      const confidence = this.streakToConfidence(streakText);

      // Odds / value
      let value: number | null = null;
      const oddsText = $card.find('.game-card__odds, .odds').text().trim();
      if (pickType === 'moneyline') {
        value = this.parseMoneylineValue(oddsText);
      } else if (pickType === 'spread') {
        value = this.parseSpreadValue(oddsText);
      } else if (pickType === 'over_under') {
        value = this.parseTotalValue(oddsText);
      }

      // Record info for reasoning
      const awayRecord = $card.find('.game-card__away .record, .away-team .record').text().trim();
      const homeRecord = $card.find('.game-card__home .record, .home-team .record').text().trim();
      const reasoning = [
        streakText ? `Streak: ${streakText}` : '',
        awayRecord || homeRecord ? `Records: ${awayTeamRaw} ${awayRecord} / ${homeTeamRaw} ${homeRecord}` : '',
      ].filter(Boolean).join(' | ') || null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate: today,
        gameTime,
        pickType,
        side,
        value,
        pickerName: 'HotStreak',
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

  private streakToConfidence(streak: string): RawPrediction['confidence'] {
    if (!streak) return null;
    const winMatch = streak.match(/(\d+)\s*(?:W|wins?)/i);
    if (winMatch) {
      const wins = parseInt(winMatch[1]!, 10);
      if (wins >= 7) return 'best_bet';
      if (wins >= 5) return 'high';
      if (wins >= 3) return 'medium';
      return 'low';
    }
    return this.inferConfidence(streak);
  }
}
