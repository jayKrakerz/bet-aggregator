import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, PickType } from '../types/prediction.js';

/**
 * BetIdeas Tennis adapter (betideas.com/tips/tennis).
 *
 * Modern SPA with betting tips displayed in card format. Tips include
 * expert analysis, odds, and confidence ratings.
 *
 * Expected page structure (after browser render):
 *   - Tip cards: `.tip-card`, `[class*="TipCard"]`, `article[class*="tip"]`
 *   - Match: `.match-info`, `.event` with "Player1 vs Player2"
 *   - Expert pick: `.tip-pick`, `.selection` with outcome
 *   - Expert name: `.expert-name`, `.tipster`, `.author`
 *   - Odds: `.tip-odds`, `.odds-value`
 *   - Analysis: `.tip-analysis`, `.content`, `.reasoning`
 *   - Confidence: `.rating`, `.stars`, `.confidence` (star or number rating)
 *   - Date: `.tip-date`, `.event-date`, `time` element
 */
export class BetIdeasTennisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'betideas-tennis',
    name: 'BetIdeas Tennis',
    baseUrl: 'https://www.betideas.com',
    fetchMethod: 'browser',
    paths: {
      tennis: '/tips/tennis/',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 6000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('.tennis-tip-card, .tennis-tips-section', {
      timeout: 15000,
    }).catch(() => {});
    await page.waitForTimeout(3000);
    // Load more tips
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // BetIdeas uses .tennis-tip-card containers with structured match data
    $('.tennis-tip-card').each((_i, el) => {
      const $card = $(el);

      // Extract tournament/date from channel header: "Mar 11 - Atp - Singles: Indian Wells (Usa), Hard"
      const channelText = $card.find('.tennis-tip-card-channels-first').text().trim();
      const gameDate = this.parseChannelDate(channelText, fetchedAt);
      const tournament = channelText || null;

      // Extract player names from .tennis-tip-team-data spans
      const teamEls = $card.find('.tennis-tip-team-data span');
      if (teamEls.length < 2) return;
      const player1 = $(teamEls[0]).text().trim();
      const player2 = $(teamEls[1]).text().trim();
      if (!player1 || !player2) return;

      // Extract match start time
      const timeText = $card.find('.tennis-tip-time').text().trim();
      const gameTime = timeText || null;

      // Extract prediction from .tennis-tip-predict-box-body: "J. Sinner @ 1.06"
      const predBoxText = $card.find('.tennis-tip-predict-box-body').text().trim();
      const predHeader = $card.find('.tennis-tip-predict-box-header').text().trim();
      const pickType = this.inferPickTypeFromHeader(predHeader);

      // Determine the predicted winner and odds
      let side: Side = 'home';
      let value: number | null = null;

      // Extract decimal odds from the prediction box
      const oddsText = $card.find('.tennis-decimal-odds').text().trim();
      const odds = parseFloat(oddsText);
      if (!isNaN(odds) && odds > 1) value = odds;

      if (pickType === 'over_under') {
        side = predBoxText.toLowerCase().includes('under') ? 'under' : 'over';
        value = this.parseTotalValue(predBoxText);
      } else {
        // Determine which player is picked by matching name in prediction text
        side = this.resolveSide(predBoxText, player1, player2);
      }

      // Extract probability from progress bar: "Probability 89.4%"
      const probText = $card.find('.tennis-tip-progress-bar span').text().trim();
      const confidence = this.parseProbability(probText);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate,
        gameTime,
        pickType,
        side,
        value,
        pickerName: 'BetIdeas',
        confidence,
        reasoning: [tournament, probText].filter(Boolean).join(' | ').slice(0, 500) || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private resolveSide(predText: string, player1: string, player2: string): Side {
    const lower = predText.toLowerCase();
    const p1Last = player1.toLowerCase().split(' ').pop() || '';
    const p2Last = player2.toLowerCase().split(' ').pop() || '';

    if (lower.includes('over')) return 'over';
    if (lower.includes('under')) return 'under';
    if (p2Last.length > 2 && lower.includes(p2Last)) return 'away';
    if (p1Last.length > 2 && lower.includes(p1Last)) return 'home';
    return 'home';
  }

  private inferPickTypeFromHeader(text: string): PickType {
    const lower = text.toLowerCase();
    if (lower.includes('over') || lower.includes('under') || lower.includes('total') || lower.includes('games')) return 'over_under';
    if (lower.includes('spread') || lower.includes('handicap')) return 'spread';
    // "Team To Win" => moneyline
    return 'moneyline';
  }

  private parseProbability(text: string): RawPrediction['confidence'] {
    const match = text.match(/([\d.]+)%/);
    if (!match) return null;
    const pct = parseFloat(match[1]!);
    if (pct >= 85) return 'best_bet';
    if (pct >= 70) return 'high';
    if (pct >= 55) return 'medium';
    return 'low';
  }

  private parseChannelDate(text: string, fetchedAt: Date): string {
    // Format: "Mar 11 - Atp - Singles: Indian Wells (Usa), Hard"
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const match = text.match(/([A-Za-z]{3})\s+(\d{1,2})/);
    if (match) {
      const mon = months[match[1]!.toLowerCase()];
      if (mon) {
        const day = match[2]!.padStart(2, '0');
        return `${fetchedAt.getFullYear()}-${mon}-${day}`;
      }
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
