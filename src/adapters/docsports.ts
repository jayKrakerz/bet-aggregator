import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Doc's Sports adapter.
 *
 * Static WordPress site with a 2-step scraping approach:
 * 1. Index page (`/free-picks/nba/`) lists articles with schema.org structured data
 * 2. Detail pages contain the pick in format: "{Author}'s Pick: Take {Team}"
 *
 * Index page: `.views-row` items with meta[itemprop="homeTeam"/"awayTeam"]
 * Detail page: `h1.article-header` title, pick in `.Text p strong`
 *
 * NOTE: Title format is "Away vs Home" (away listed first).
 */
export class DocsSportsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'docsports',
    name: "Doc's Sports",
    baseUrl: 'https://www.docsports.com',
    fetchMethod: 'http',
    paths: {
      nba: '/free-picks/nba/',
      nfl: '/free-picks/nfl/',
      mlb: '/free-picks/mlb/',
      nhl: '/free-picks/nhl/',
      ncaab: '/free-picks/college-basketball/',
    },
    cron: '0 0 9,14,19 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  discoverUrls(html: string, _sport: string): string[] {
    const $ = this.load(html);
    const urls: string[] = [];
    const today = new Date();
    const todayStr = `${today.getMonth() + 1}-${today.getDate()}-${today.getFullYear()}`;

    // Index page links are in .views-row or in <b>/<strong> tags
    $('a[href*="prediction"], a[href*="preview-and-pick"]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      if (!href.includes(todayStr) && !href.includes(`${today.getFullYear()}`)) return;

      const fullUrl = href.startsWith('http')
        ? href
        : href.startsWith('//')
          ? `https:${href}`
          : `${this.config.baseUrl}${href}`;
      if (!urls.includes(fullUrl)) urls.push(fullUrl);
    });

    return urls.slice(0, 15);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);

    // Detail page has h1.article-header
    if ($('h1.article-header').length > 0) {
      return this.parseDetailPage($, sport, fetchedAt);
    }

    // Index page has .views-row items
    return this.parseIndexPage($, sport, fetchedAt);
  }

  private parseIndexPage(
    $: ReturnType<typeof this.load>,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    $('.views-row').each((_i, el) => {
      const $row = $(el);

      // Structured data: homeTeam / awayTeam from schema.org meta tags
      const homeTeam = $row.find('[itemprop="homeTeam"] meta[itemprop="name"]').attr('content')?.trim();
      const awayTeam = $row.find('[itemprop="awayTeam"] meta[itemprop="name"]').attr('content')?.trim();
      if (!homeTeam || !awayTeam) return;

      // Date from startDate meta
      const startDate = $row.find('meta[itemprop="startDate"]').attr('content') || '';
      const gameDate = startDate ? startDate.split('T')[0]! : fetchedAt.toISOString().split('T')[0]!;

      // Expert from "by Author - Date" in <p> text
      const pText = $row.find('p').first().text().trim();
      const byMatch = pText.match(/by\s+(.+?)\s*-/i);
      const expert = byMatch ? byMatch[1]!.trim() : "Doc's Sports";

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate,
        gameTime: null,
        pickType: 'moneyline',
        side: 'home',
        value: null,
        pickerName: expert,
        confidence: 'medium',
        reasoning: null,
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
    // Title: "Away Team vs Home Team Prediction, M/D/YYYY Preview and Pick"
    const title = $('h1.article-header').text().trim();
    const titleMatchup = this.parseTitleMatchup(title);

    // Try JSON-LD for correct home/away assignment
    let homeTeam = '';
    let awayTeam = '';
    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const data = JSON.parse($(el).html() || '');
        if (data.homeTeam?.name) homeTeam = data.homeTeam.name;
        if (data.awayTeam?.name) awayTeam = data.awayTeam.name;
      } catch { /* skip */ }
    });

    // Fallback to title parsing (away vs home order)
    if ((!homeTeam || !awayTeam) && titleMatchup) {
      awayTeam = titleMatchup.away;
      homeTeam = titleMatchup.home;
    }

    if (!homeTeam || !awayTeam) return [];

    // Date from title
    const dateMatch = title.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})/);
    let gameDate = fetchedAt.toISOString().split('T')[0]!;
    if (dateMatch) {
      gameDate = `${dateMatch[3]}-${dateMatch[1]!.padStart(2, '0')}-${dateMatch[2]!.padStart(2, '0')}`;
    }

    // Author from byline
    const bylineText = $('.featured-article-content > .Text').first().find('i').text().trim();
    const byMatch = bylineText.match(/by\s+(.+?)(?:\s*-|$)/i);
    const expert = byMatch ? byMatch[1]!.trim() : "Doc's Sports";

    // Find the pick: "{Author}'s Pick: Take {Team}" pattern
    const bodyText = $('.featured-article-content .Text').last().text();
    const pickMatch = bodyText.match(/(\w[\w\s']+)'s Pick:\s*Take\s+(.+?)$/m);

    if (!pickMatch) return [];

    const pickTeam = pickMatch[2]!.trim();

    // Determine side based on which team name the pick matches
    let side: Side = 'home';
    const pickLower = pickTeam.toLowerCase();
    const homeLower = homeTeam.toLowerCase();
    const awayLower = awayTeam.toLowerCase();

    // Check last word (city or mascot) of each team
    const homeWords = homeLower.split(/\s+/);
    const awayWords = awayLower.split(/\s+/);

    if (awayWords.some(w => w.length > 2 && pickLower.includes(w))) side = 'away';
    else if (homeWords.some(w => w.length > 2 && pickLower.includes(w))) side = 'home';

    // Check for "and under/over the total"
    let hasOU = false;
    let ouSide: Side = 'under';
    if (pickLower.includes('under the total') || pickLower.includes('under total')) {
      hasOU = true;
      ouSide = 'under';
    } else if (pickLower.includes('over the total') || pickLower.includes('over total')) {
      hasOU = true;
      ouSide = 'over';
    }

    const predictions: RawPrediction[] = [{
      sourceId: this.config.id,
      sport,
      homeTeamRaw: homeTeam,
      awayTeamRaw: awayTeam,
      gameDate,
      gameTime: null,
      pickType: 'moneyline',
      side,
      value: null,
      pickerName: expert,
      confidence: 'medium',
      reasoning: `${expert}'s Pick: Take ${pickTeam}`,
      fetchedAt,
    }];

    if (hasOU) {
      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate,
        gameTime: null,
        pickType: 'over_under',
        side: ouSide,
        value: null,
        pickerName: expert,
        confidence: 'medium',
        reasoning: `${expert}'s Pick: Take ${pickTeam}`,
        fetchedAt,
      });
    }

    return predictions;
  }

  /**
   * Title format is "Away vs Home Prediction, ..."
   */
  private parseTitleMatchup(title: string): { home: string; away: string } | null {
    const match = title.match(/(.+?)\s+vs\.?\s+(.+?)(?:\s+Prediction|\s+Pick|\s+Preview|\s+Best|\s*,|\s*$)/i);
    if (!match) return null;
    // First team is AWAY, second is HOME
    return { away: match[1]!.trim(), home: match[2]!.trim() };
  }
}
