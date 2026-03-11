import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction } from '../types/prediction.js';

/**
 * HoopsHype adapter.
 *
 * STATUS: URL returns 404 "Page Not Found". The prediction path
 * no longer exists on hoopshype.com. Check for updated URL.
 *
 * HoopsHype is an NBA-focused news site that publishes game
 * previews with predictions and projected outcomes.
 *
 * Page structure:
 * - `.scoreboard-game, .game-card`: game container
 * - `.team-name, .team`: team names
 * - `.game-preview .prediction`: prediction text
 * - `.game-date`: date of the game
 * - Article previews may have prediction in article body
 *
 * Also tries JSON-LD structured data if available.
 */
export class HoopshypeAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'hoopshype',
    name: 'HoopsHype',
    baseUrl: 'https://hoopshype.com',
    fetchMethod: 'http',
    paths: {
      nba: '/games/',
    },
    cron: '0 0 9,15 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    // Parse scoreboard/game cards
    $('.scoreboard-game, .game-card, .game-item, .schedule-game').each((_i, el) => {
      const $card = $(el);

      const teamEls = $card.find('.team-name, .team, .team-info');
      if (teamEls.length < 2) return;
      const awayTeamRaw = $(teamEls[0]).text().trim();
      const homeTeamRaw = $(teamEls[1]).text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      const dateText = $card.find('.game-date, .date, time').text().trim();
      const gameDate = this.extractDate(dateText) || todayStr;
      const gameTime = $card.find('.game-time, .time').text().trim() || null;

      // Look for prediction text
      const predText = $card.find('.prediction, .pick, .game-preview .winner').text().trim();
      const side = this.resolveSide(predText, awayTeamRaw, homeTeamRaw);

      // Look for projected score
      const scoreEls = $card.find('.projected-score, .score-prediction');
      let reasoning: string | null = predText || null;
      if (scoreEls.length >= 2) {
        const awayScore = $(scoreEls[0]).text().trim();
        const homeScore = $(scoreEls[1]).text().trim();
        reasoning = `Projected: ${awayTeamRaw} ${awayScore} - ${homeTeamRaw} ${homeScore}`;
      }

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
        pickerName: 'HoopsHype',
        confidence: null,
        reasoning: reasoning ? reasoning.slice(0, 300) : null,
        fetchedAt,
      });
    });

    // Fallback: parse game preview articles
    if (predictions.length === 0) {
      $('.post-item, .article-card, .preview-card').each((_i, el) => {
        const $article = $(el);
        const title = $article.find('.post-title, .article-title, h2, h3').text().trim();

        const vsMatch = title.match(/^(.+?)\s+(?:vs\.?|at)\s+(.+?)(?:\s*[-–(:]|$)/i);
        if (!vsMatch) return;

        const awayTeamRaw = vsMatch[1]!.trim();
        const homeTeamRaw = vsMatch[2]!.trim();

        const excerpt = $article.find('.post-excerpt, .excerpt, p').text().trim();
        const pickMatch = excerpt.match(/(?:prediction|pick|winner):\s*(.+?)(?:\.|$)/i);
        const pickText = pickMatch ? pickMatch[1]!.trim() : '';

        const side = this.resolveSide(pickText, awayTeamRaw, homeTeamRaw);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: todayStr,
          gameTime: null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'HoopsHype',
          confidence: null,
          reasoning: pickText ? pickText.slice(0, 300) : null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private resolveSide(text: string, away: string, home: string): 'home' | 'away' {
    const lower = text.toLowerCase();
    const awayLast = away.toLowerCase().split(' ').pop()!;
    const homeLast = home.toLowerCase().split(' ').pop()!;
    if (lower.includes(awayLast)) return 'away';
    if (lower.includes(homeLast)) return 'home';
    return 'home';
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
