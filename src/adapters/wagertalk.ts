import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side, Confidence } from '../types/prediction.js';

/**
 * WagerTalk adapter.
 *
 * Server-rendered WordPress site. Pick data is in `div.pro-card` elements:
 *   h2 > a[href*="/profile/"]       — expert name
 *   div.content-event               — matchup "(545) Team A at (546) Team B: Spread"
 *   div.content-play                — pick "Memphis Grizzlies +14.0 (-110)"
 *   div.content-date                — "March 3, 2026 8:10 PM EST"
 *   p.article-short-desc            — reasoning (in sibling container)
 */
export class WagerTalkAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'wagertalk',
    name: 'WagerTalk',
    baseUrl: 'https://www.wagertalk.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/free-sports-picks/nba',
      nfl: '/free-sports-picks/nfl',
      mlb: '/free-sports-picks/mlb',
      nhl: '/free-sports-picks/nhl',
    },
    cron: '0 0 9,13,17,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('div.pro-card', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('div.pro-card').each((_i, el) => {
      const $card = $(el);

      // Expert name from h2 > a
      const expert = $card.find('h2 a[href*="/profile/"]').first().text().trim()
        || $card.find('a[href*="/profile/"]').first().text().trim();

      // Event/matchup: "(545) Memphis Grizzlies at (546) Minnesota Timberwolves: Spread"
      const eventText = $card.find('.content-event').text().trim();
      if (!eventText) return;

      const matchup = this.parseEventText(eventText);
      if (!matchup) return;

      // Pick: "Memphis Grizzlies +14.0 (-110)"
      const playText = $card.find('.content-play').text().trim();
      if (!playText) return;

      const pickInfo = this.parsePlayText(playText, matchup.home, matchup.away, matchup.betType);

      // Date/time
      const dateText = $card.find('.content-date').text().trim();

      // Reasoning from sibling analysis container
      const reasoning = $card.next('.news-articles-container').find('.article-short-desc').text().trim().slice(0, 300) || null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup.home,
        awayTeamRaw: matchup.away,
        gameDate: fetchedAt.toISOString().split('T')[0]!,
        gameTime: dateText || null,
        pickType: pickInfo.pickType,
        side: pickInfo.side,
        value: pickInfo.value,
        pickerName: expert || 'WagerTalk Expert',
        confidence: pickInfo.confidence,
        reasoning,
        fetchedAt,
      });
    });

    return predictions;
  }

  /**
   * Parse event text like "(545) Memphis Grizzlies at (546) Minnesota Timberwolves: Spread"
   */
  private parseEventText(text: string): { home: string; away: string; betType: string } | null {
    // Strip rotation numbers "(NNN) "
    const cleaned = text.replace(/\(\d+\)\s*/g, '');

    // Split off bet type after ": "
    let betType = '';
    let matchText = cleaned;
    const colonIdx = cleaned.lastIndexOf(':');
    if (colonIdx > 0) {
      betType = cleaned.slice(colonIdx + 1).trim();
      matchText = cleaned.slice(0, colonIdx).trim();
    }

    // "Team A at Team B" — away is first, home is after "at"
    const atMatch = matchText.match(/^(.+?)\s+at\s+(.+)$/i);
    if (atMatch) {
      return { away: atMatch[1]!.trim(), home: atMatch[2]!.trim(), betType };
    }

    const vsMatch = matchText.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
    if (vsMatch) {
      return { home: vsMatch[1]!.trim(), away: vsMatch[2]!.trim(), betType };
    }

    return null;
  }

  /**
   * Parse play text like "Memphis Grizzlies +14.0 (-110)" or "Over 23.5 Points..."
   */
  private parsePlayText(
    text: string,
    home: string,
    away: string,
    betType: string,
  ): { pickType: PickType; side: Side; value: number | null; confidence: Confidence | null } {
    const lower = text.toLowerCase();
    const btLower = betType.toLowerCase();

    // Detect pick type
    let pickType: PickType = 'spread';
    if (btLower.includes('moneyline') || btLower === 'ml' || lower.includes('moneyline')) {
      pickType = 'moneyline';
    } else if (btLower.includes('total') || lower.includes('over') || lower.includes('under')) {
      pickType = 'over_under';
    } else if (btLower.includes('prop') || lower.includes('rebounds') || lower.includes('assists') || lower.includes('points +')) {
      pickType = 'prop';
    } else if (btLower.includes('spread') || text.match(/[+-]\d+\.?\d*\s*\(/)) {
      pickType = 'spread';
    }

    // Detect side
    let side: Side = 'home';
    if (pickType === 'over_under') {
      side = lower.includes('under') ? 'under' : 'over';
    } else {
      const homeLastWord = home.split(/\s+/).pop()?.toLowerCase() || '';
      const awayLastWord = away.split(/\s+/).pop()?.toLowerCase() || '';
      if (awayLastWord && lower.includes(awayLastWord)) side = 'away';
      else if (homeLastWord && lower.includes(homeLastWord)) side = 'home';
    }

    // Extract value: "+14.0 (-110)" → 14.0
    let value: number | null = null;
    const spreadMatch = text.match(/([+-]\d+\.?\d*)\s*\([+-]?\d+\)/);
    if (spreadMatch) {
      value = parseFloat(spreadMatch[1]!);
    } else {
      const numMatch = text.match(/(?:over|under)\s+(\d+\.?\d*)/i);
      if (numMatch) value = parseFloat(numMatch[1]!);
    }

    // Extract odds for confidence
    const oddsMatch = text.match(/\(([+-]\d+)\)/);
    const odds = oddsMatch ? parseInt(oddsMatch[1]!, 10) : null;
    let confidence: Confidence | null = null;
    if (odds) {
      const absOdds = Math.abs(odds);
      if (absOdds >= 200) confidence = 'high';
      else if (absOdds >= 150) confidence = 'medium';
      else confidence = 'low';
    }

    return { pickType, side, value, confidence };
  }
}
