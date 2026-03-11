import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * ClutchPoints adapter.
 *
 * STATUS: URL /nba-predictions-today returns 404. The site is a Next.js SPA
 * and this path no longer exists. Check for updated prediction URL.
 *
 * ClutchPoints publishes NBA game predictions with spread and
 * over/under picks for each daily matchup.
 *
 * Page structure:
 * - `.prediction-card, .game-card`: game prediction container
 * - `.team-name, .team__name`: team names (away first, then home)
 * - `.pick-value, .prediction-pick`: the recommended pick
 * - `.spread-pick, .total-pick`: spread and total predictions
 * - `.game-meta .date`: game date
 * - Article-based: `h2, h3` with matchup titles, picks in paragraphs
 */
export class ClutchPointsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'clutchpoints',
    name: 'ClutchPoints',
    baseUrl: 'https://clutchpoints.com',
    fetchMethod: 'http',
    paths: {
      nba: '/nba-predictions-today',
    },
    cron: '0 0 9,15,21 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    // Try structured prediction cards
    $('.prediction-card, .game-card, .matchup-card').each((_i, el) => {
      const $card = $(el);
      const teams = $card.find('.team-name, .team__name, .team');
      if (teams.length < 2) return;

      const awayTeamRaw = $(teams[0]).text().trim();
      const homeTeamRaw = $(teams[1]).text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;

      const dateText = $card.find('.date, .game-date').text().trim();
      const gameDate = this.extractDate(dateText) || todayStr;

      // Spread pick
      const spreadText = $card.find('.spread-pick, .spread .pick-value').text().trim();
      if (spreadText) {
        const spreadVal = this.parseSpreadValue(spreadText);
        const side = this.resolvePickSide(spreadText, awayTeamRaw, homeTeamRaw);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime: null,
          pickType: 'spread',
          side,
          value: spreadVal,
          pickerName: 'ClutchPoints',
          confidence: null,
          reasoning: `Spread pick: ${spreadText}`,
          fetchedAt,
        });
      }

      // Over/under pick
      const totalText = $card.find('.total-pick, .over-under .pick-value').text().trim();
      if (totalText) {
        const totalVal = this.parseTotalValue(totalText);
        const ouSide: Side = totalText.toLowerCase().includes('under') ? 'under' : 'over';
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime: null,
          pickType: 'over_under',
          side: ouSide,
          value: totalVal,
          pickerName: 'ClutchPoints',
          confidence: null,
          reasoning: `Total pick: ${totalText}`,
          fetchedAt,
        });
      }

      // Moneyline / winner pick
      const winnerText = $card.find('.pick-value, .prediction-pick, .winner-pick').text().trim();
      if (winnerText || (!spreadText && !totalText)) {
        const side = this.resolvePickSide(winnerText, awayTeamRaw, homeTeamRaw);
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
          pickerName: 'ClutchPoints',
          confidence: null,
          reasoning: winnerText ? `Pick: ${winnerText}` : null,
          fetchedAt,
        });
      }
    });

    // Fallback: article-based parsing
    if (predictions.length === 0) {
      this.parseArticle($, sport, fetchedAt, predictions);
    }

    return predictions;
  }

  /** Parse article-based predictions from headings and paragraphs. */
  private parseArticle(
    $: ReturnType<typeof this.load>,
    sport: string,
    fetchedAt: Date,
    predictions: RawPrediction[],
  ): void {
    const todayStr = fetchedAt.toISOString().split('T')[0]!;
    const content = $('.entry-content, .post-content, .article-body').first();

    content.find('h2, h3').each((_i, el) => {
      const heading = $(el).text().trim();
      const vsMatch = heading.match(/^(.+?)\s+(?:vs\.?|at)\s+(.+?)(?:\s*[-–(]|$)/i);
      if (!vsMatch) return;

      const awayTeamRaw = vsMatch[1]!.trim();
      const homeTeamRaw = vsMatch[2]!.trim();

      // Scan next elements for pick
      let pickText = '';
      let next = $(el).next();
      for (let j = 0; j < 8 && next.length; j++) {
        if (next.is('h2, h3')) break;
        const text = next.text();
        const pm = text.match(/(?:pick|prediction|best bet):\s*(.+?)(?:\.|$)/i);
        if (pm) { pickText = pm[1]!.trim(); break; }
        next = next.next();
      }

      const side = this.resolvePickSide(pickText, awayTeamRaw, homeTeamRaw);
      const pickType = this.inferPickType(pickText);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate: todayStr,
        gameTime: null,
        pickType,
        side,
        value: pickType === 'spread' ? this.parseSpreadValue(pickText) : null,
        pickerName: 'ClutchPoints',
        confidence: null,
        reasoning: pickText.slice(0, 300) || null,
        fetchedAt,
      });
    });
  }

  private resolvePickSide(text: string, away: string, home: string): Side {
    const lower = text.toLowerCase();
    if (lower.includes('under')) return 'under';
    if (lower.includes('over')) return 'over';
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
