import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * PickDawgz adapter.
 *
 * WordPress site, server-rendered. Two-step scraping:
 * 1. Index page: li.latest-picks__game with h4.game__title > a.game__link
 * 2. Detail page: h3 containing "'s Pick:" for the actual recommendation,
 *    table.free-pick-table for spread/ML/total data,
 *    div.free-pick-details-table meta[itemprop="startDate"] for game time
 *
 * Title format: "{Away} vs {Home} Prediction {M/D/YYYY} Today's NBA Picks"
 */
export class PickDawgzAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'pickdawgz',
    name: 'PickDawgz',
    baseUrl: 'https://pickdawgz.com',
    fetchMethod: 'http',
    paths: {
      nba: '/nba-picks/',
      nfl: '/nfl-picks/',
      mlb: '/mlb-picks/',
      nhl: '/nhl-picks/',
      ncaab: '/college-basketball-picks/',
    },
    cron: '0 0 8,12,16,20 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  discoverUrls(html: string, _sport: string): string[] {
    const $ = this.load(html);
    const urls: string[] = [];
    const today = new Date();
    const todayStr = `${today.getFullYear()}`;

    $('li.latest-picks__game:not(.league-offer) a.game__link[href]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      // Only get current year articles
      if (!href.includes(todayStr)) return;
      const fullUrl = href.startsWith('http') ? href : `${this.config.baseUrl}${href}`;
      if (!urls.includes(fullUrl)) urls.push(fullUrl);
    });

    return urls.slice(0, 15);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);

    // Detail page: has the pick table or pick heading
    if ($('table.free-pick-table').length > 0 || $('h3').filter((_i, el) => $(el).text().includes("'s Pick:")).length > 0) {
      return this.parseDetailPage($, sport, fetchedAt);
    }

    // Index page
    return this.parseIndexPage($, sport, fetchedAt);
  }

  private parseIndexPage(
    $: ReturnType<typeof this.load>,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    $('li.latest-picks__game:not(.league-offer)').each((_i, el) => {
      const $card = $(el);
      const title = $card.find('h4.game__title a.game__link').text().trim();
      const matchup = this.parseTitleMatchup(title);
      if (!matchup) return;

      const author = $card.find('span.game__author').text().trim();
      const dateText = $card.find('span.game__date').text().trim();
      const gameDate = this.parseLongDate(dateText) || fetchedAt.toISOString().split('T')[0]!;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup.home,
        awayTeamRaw: matchup.away,
        gameDate,
        gameTime: null,
        pickType: 'spread',
        side: 'home',
        value: null,
        pickerName: author || 'PickDawgz',
        confidence: null,
        reasoning: $card.find('p.game__excerpt').text().trim().slice(0, 300) || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseDetailPage(
    $: ReturnType<typeof this.load>,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];
    const title = $('h1').first().text().trim();
    const matchup = this.parseTitleMatchup(title);
    if (!matchup) return [];

    // Game date from schema or title
    const startDate = $('div.free-pick-details-table meta[itemprop="startDate"]').attr('content');
    const gameDate = startDate
      ? startDate.split('T')[0]!
      : this.parseTitleDate(title) || fetchedAt.toISOString().split('T')[0]!;

    // Game time from table
    let gameTime: string | null = null;
    $('table.free-pick-table tbody tr').each((_i, el) => {
      const cells = $(el).find('td');
      const label = $(cells[0]).text().trim();
      if (label === 'Time') {
        gameTime = $(cells[1]).text().trim() || null;
      }
    });

    // Author from meta or byline
    const author = $('meta[name="author"]').attr('content')?.trim()
      || $('span.post-author a').text().trim()
      || 'PickDawgz';

    // The actual pick: h3 containing "'s Pick:"
    let pickFound = false;
    $('h3').each((_i, el) => {
      const text = $(el).text().trim();
      const pickMatch = text.match(/Pick:\s*(.+)$/i);
      if (!pickMatch) return;
      pickFound = true;

      const pickContent = pickMatch[1]!.trim();
      const parsed = this.parsePickContent(pickContent, matchup);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup.home,
        awayTeamRaw: matchup.away,
        gameDate,
        gameTime,
        pickType: parsed.pickType,
        side: parsed.side,
        value: parsed.value,
        pickerName: author,
        confidence: 'medium',
        reasoning: pickContent,
        fetchedAt,
      });
    });

    // Fallback: parse spread/ML/total from the table if no explicit pick found
    if (!pickFound) {
      const spread = this.getTableValue($, 'Spread');
      if (spread) {
        const spreadVal = this.parseSpreadValue(spread);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: matchup.home,
          awayTeamRaw: matchup.away,
          gameDate,
          gameTime,
          pickType: 'spread',
          side: 'home',
          value: spreadVal,
          pickerName: author,
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      }
    }

    return predictions;
  }

  private getTableValue($: ReturnType<typeof this.load>, label: string): string | null {
    let value: string | null = null;
    $('table.free-pick-table tbody tr').each((_i, el) => {
      const cells = $(el).find('td, th');
      if ($(cells[0]).text().trim() === label) {
        // Home team is 3rd column (index 2)
        value = $(cells[2]).text().trim() || $(cells[1]).text().trim() || null;
      }
    });
    return value;
  }

  private parsePickContent(text: string, matchup: { home: string; away: string }): {
    pickType: RawPrediction['pickType'];
    side: Side;
    value: number | null;
  } {
    const lower = text.toLowerCase();
    if (lower.startsWith('over') || lower.startsWith('under')) {
      const totalMatch = text.match(/(over|under)\s+([\d.]+)/i);
      return {
        pickType: 'over_under',
        side: lower.startsWith('over') ? 'over' : 'under',
        value: totalMatch ? parseFloat(totalMatch[2]!) : null,
      };
    }

    // "Phoenix Suns -10.5" or "Memphis +14.5"
    const spreadMatch = text.match(/^(.+?)\s+([-+][\d.]+)\s*$/);
    if (spreadMatch) {
      return {
        pickType: 'spread',
        side: this.teamToSide(spreadMatch[1]!.trim(), matchup.home, matchup.away),
        value: parseFloat(spreadMatch[2]!),
      };
    }

    // Just a team name (moneyline)
    return {
      pickType: 'moneyline',
      side: this.teamToSide(text, matchup.home, matchup.away),
      value: null,
    };
  }

  private parseTitleMatchup(title: string): { home: string; away: string } | null {
    const match = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s+Prediction|\s+Picks?)/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
  }

  private parseTitleDate(title: string): string | null {
    const match = title.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!match) return null;
    return `${match[3]}-${match[1]!.padStart(2, '0')}-${match[2]!.padStart(2, '0')}`;
  }

  private parseLongDate(text: string): string | null {
    const months: Record<string, string> = {
      january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
      july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
    };
    const match = text.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/i);
    if (!match) return null;
    const m = months[match[1]!.toLowerCase()];
    if (!m) return null;
    return `${match[3]}-${m}-${match[2]!.padStart(2, '0')}`;
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
