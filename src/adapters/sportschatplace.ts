import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Sports Chat Place adapter.
 *
 * WordPress (Jannah theme), server-rendered. Two-step scraping:
 * 1. Index page: li.post-item with h2.post-title a linking to articles
 * 2. Detail page: "Free Pick:" heading with the actual spread recommendation,
 *    "The Line:" text for spread/total reference data
 *
 * Title format: "{Away} vs {Home} Prediction {M/D/YY} NBA Picks Today"
 */
export class SportsChatPlaceAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'sportschatplace',
    name: 'Sports Chat Place',
    baseUrl: 'https://sportschatplace.com',
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
    $('li.post-item h2.post-title a[href]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      if (!href.includes('prediction')) return;
      const fullUrl = href.startsWith('http') ? href : `${this.config.baseUrl}${href}`;
      if (!urls.includes(fullUrl)) urls.push(fullUrl);
    });

    return urls.slice(0, 15);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);

    // Detail page: has "Free Pick:" text
    const bodyText = $('article, .entry-content, .post-content').text();
    if (bodyText.includes('Free Pick:')) {
      return this.parseDetailPage($, bodyText, sport, fetchedAt);
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

    $('li.post-item').each((_i, el) => {
      const $card = $(el);
      const title = $card.find('h2.post-title a').text().trim();
      const matchup = this.parseTitleMatchup(title);
      if (!matchup) return;

      const author = $card.find('.post-author a').text().trim();
      const dateText = $card.find('.post-date').text().trim();
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
        pickerName: author || 'Sports Chat Place',
        confidence: null,
        reasoning: $card.find('.post-excerpt').text().trim().slice(0, 300) || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseDetailPage(
    $: ReturnType<typeof this.load>,
    bodyText: string,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];
    const title = $('h1').first().text().trim();
    const matchup = this.parseTitleMatchup(title);
    if (!matchup) return [];

    // Date from title
    const gameDate = this.parseTitleDate(title) || fetchedAt.toISOString().split('T')[0]!;

    // Author
    const author = $('meta[name="author"]').attr('content')?.trim()
      || $('.post-author a').first().text().trim()
      || 'Sports Chat Place';

    // Parse "The Line:" for spread reference
    const lineMatch = bodyText.match(/The Line:\s*(.+?);\s*Over\/Under:\s*([\d.]+)/i);
    const totalValue = lineMatch ? parseFloat(lineMatch[2]!) : null;

    // Find the free pick
    const freePickMatch = bodyText.match(/Free Pick:\s*(.+?)(?:\n|$)/i);
    if (freePickMatch) {
      const pickContent = freePickMatch[1]!.trim();
      const parsed = this.parsePickContent(pickContent, matchup);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup.home,
        awayTeamRaw: matchup.away,
        gameDate,
        gameTime: null,
        pickType: parsed.pickType,
        side: parsed.side,
        value: parsed.value,
        pickerName: author,
        confidence: 'medium',
        reasoning: pickContent,
        fetchedAt,
      });
    }

    // Also add O/U if line data was found and no O/U pick exists
    if (totalValue && !predictions.some(p => p.pickType === 'over_under')) {
      const ouMatch = bodyText.match(/(?:take|like|lean)\s+the\s+(over|under)/i);
      if (ouMatch) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: matchup.home,
          awayTeamRaw: matchup.away,
          gameDate,
          gameTime: null,
          pickType: 'over_under',
          side: ouMatch[1]!.toLowerCase() === 'over' ? 'over' : 'under',
          value: totalValue,
          pickerName: author,
          confidence: 'low',
          reasoning: null,
          fetchedAt,
        });
      }
    }

    return predictions;
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

    // "Phoenix -10.5" or "Memphis +14.5"
    const spreadMatch = text.match(/^(.+?)\s+([-+][\d.]+)/);
    if (spreadMatch) {
      return {
        pickType: 'spread',
        side: this.teamToSide(spreadMatch[1]!.trim(), matchup.home, matchup.away),
        value: parseFloat(spreadMatch[2]!),
      };
    }

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
    // "3/3/26" format
    const match = title.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!match) return null;
    const year = match[3]!.length === 2 ? `20${match[3]}` : match[3]!;
    return `${year}-${match[1]!.padStart(2, '0')}-${match[2]!.padStart(2, '0')}`;
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
