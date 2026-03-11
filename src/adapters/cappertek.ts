import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side } from '../types/prediction.js';

/**
 * CapperTek adapter.
 *
 * ASP.NET site with AJAX endpoints. Uses a 2-step approach:
 * 1. Index page lists games with links containing game IDs
 * 2. Detail pages (todaysPicks.asp) contain CapperTek's free AI picks:
 *    "Free Moneyline Pick: Hornets -572"
 *    "Free Spread Pick: Mavericks +11.5 (-103)"
 *    "Free Total Pick: Over 230 (-104)"
 *
 * Team names from img[alt] in team logo images.
 * Game time from span.badge.badge-light.
 */
export class CapperTekAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'cappertek',
    name: 'CapperTek',
    baseUrl: 'https://www.cappertek.com',
    fetchMethod: 'browser',
    paths: {
      nba: '/accessPicks.asp',
      nfl: '/accessPicks.asp',
      mlb: '/accessPicks.asp',
      nhl: '/accessPicks.asp',
    },
    cron: '0 0 10,14,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for AJAX-loaded pick content
    await page.waitForSelector('img[src*="teamLogos"], div.card-body', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  discoverUrls(html: string, _sport: string): string[] {
    const $ = this.load(html);
    const urls: string[] = [];

    $('a[href*="todaysPicks.asp"]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const fullUrl = href.startsWith('http') ? href : `${this.config.baseUrl}/${href}`;
      if (!urls.includes(fullUrl)) urls.push(fullUrl);
    });

    return urls.slice(0, 15);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);

    // Detail page: look for "Free Moneyline Pick:", "Free Spread Pick:", "Free Total Pick:"
    const bodyText = $('div.card-body').text();
    if (bodyText.includes('Free Moneyline Pick:') || bodyText.includes('Free Spread Pick:') || bodyText.includes('Free Total Pick:')) {
      return this.parseDetailPage($, bodyText, sport, fetchedAt);
    }

    // Index page: parse game listings from xAjaxAccessPicks content
    return this.parseIndexPage($, sport, fetchedAt);
  }

  private parseDetailPage(
    $: ReturnType<typeof this.load>,
    bodyText: string,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    // Title: "Dallas Mavericks vs. Charlotte Hornets Pick Center"
    const titleText = $('div.card-header h1').text().trim() || $('title').text().trim();
    const matchup = this.parseTitleMatchup(titleText);
    if (!matchup) return [];

    // Date from title tag: "...7:10 PM ET (3/3/2026)..."
    const dateMatch = titleText.match(/\((\d{1,2})\/(\d{1,2})\/(\d{4})\)/);
    const gameDate = dateMatch
      ? `${dateMatch[3]}-${dateMatch[1]!.padStart(2, '0')}-${dateMatch[2]!.padStart(2, '0')}`
      : fetchedAt.toISOString().split('T')[0]!;

    const timeMatch = titleText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)\s*ET)/i);
    const gameTime = timeMatch ? timeMatch[1]! : null;

    // Parse free picks
    const picks = [
      { label: 'Free Moneyline Pick:', type: 'moneyline' as PickType },
      { label: 'Free Spread Pick:', type: 'spread' as PickType },
      { label: 'Free Total Pick:', type: 'over_under' as PickType },
    ];

    for (const { label, type } of picks) {
      const regex = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(.+?)(?:\\n|$)`, 'i');
      const pickMatch = bodyText.match(regex);
      if (!pickMatch) continue;

      const pickText = pickMatch[1]!.trim();
      const parsed = this.parseFreePick(pickText, type, matchup);
      if (!parsed) continue;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup.home,
        awayTeamRaw: matchup.away,
        gameDate,
        gameTime,
        pickType: type,
        side: parsed.side,
        value: parsed.value,
        pickerName: 'CapperTek AI',
        confidence: 'medium',
        reasoning: `${label} ${pickText}`,
        fetchedAt,
      });
    }

    return predictions;
  }

  private parseIndexPage(
    $: ReturnType<typeof this.load>,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    // Parse team logos to identify matchups
    $('img[src*="teamLogos"]').each((_i, el) => {
      const teamName = $(el).attr('alt')?.trim();
      if (!teamName) return;

      // Find the closest matchup context
      const $row = $(el).closest('tr');
      const timeText = $row.find('span.badge.badge-light').text().trim();

      // Skip if we already processed this team (we see each team twice per game)
      if (_i % 2 !== 0) return;

      const nextImg = $('img[src*="teamLogos"]').eq(_i + 1);
      const opponent = nextImg.attr('alt')?.trim();
      if (!opponent) return;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: opponent,
        awayTeamRaw: teamName,
        gameDate: fetchedAt.toISOString().split('T')[0]!,
        gameTime: timeText || null,
        pickType: 'moneyline',
        side: 'home',
        value: null,
        pickerName: 'CapperTek',
        confidence: null,
        reasoning: null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseTitleMatchup(title: string): { home: string; away: string } | null {
    const match = title.match(/(.+?)\s+vs\.?\s+(.+?)(?:\s+Pick\s+Center|\s+Picks?|\s*-|$)/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
  }

  private parseFreePick(
    text: string,
    type: PickType,
    matchup: { home: string; away: string },
  ): { side: Side; value: number | null } | null {
    if (type === 'over_under') {
      const ouMatch = text.match(/(Over|Under)\s+([\d.]+)/i);
      if (ouMatch) {
        return {
          side: ouMatch[1]!.toLowerCase() === 'over' ? 'over' : 'under',
          value: parseFloat(ouMatch[2]!),
        };
      }
    }

    if (type === 'spread') {
      const spreadMatch = text.match(/(.+?)\s+([-+][\d.]+)/);
      if (spreadMatch) {
        const side = this.teamToSide(spreadMatch[1]!.trim(), matchup.home, matchup.away);
        return { side, value: parseFloat(spreadMatch[2]!) };
      }
    }

    if (type === 'moneyline') {
      const mlMatch = text.match(/(.+?)\s+([-+]?\d+)/);
      if (mlMatch) {
        const side = this.teamToSide(mlMatch[1]!.trim(), matchup.home, matchup.away);
        return { side, value: parseInt(mlMatch[2]!, 10) };
      }
    }

    return null;
  }

  private teamToSide(pickTeam: string, home: string, away: string): Side {
    const pickLower = pickTeam.toLowerCase();
    const homeWords = home.toLowerCase().split(/\s+/);
    const awayWords = away.toLowerCase().split(/\s+/);
    if (awayWords.some(w => w.length > 2 && pickLower.includes(w))) return 'away';
    if (homeWords.some(w => w.length > 2 && pickLower.includes(w))) return 'home';
    return 'home';
  }
}
