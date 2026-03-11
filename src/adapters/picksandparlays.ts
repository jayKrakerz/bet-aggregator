import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Picks & Parlays adapter.
 *
 * WordPress site (server-rendered). 2-step scraping:
 * 1. Index page: div.pap-content-item with h3 title, a[href] to article
 * 2. Detail page: h2[id$="-pick"] section contains the actual pick
 *
 * Title format: "{Away} vs {Home} Picks and Prediction(s) for {Day} {Month} {Date} {Year}"
 *
 * Kim Smith articles: ul > li starting with "Pick:" after h3 > b
 * Eddie Kline articles: prose after h2[id$="-pick"], look for "Final Score Prediction"
 */
export class PicksAndParlaysAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'picksandparlays',
    name: 'Picks & Parlays',
    baseUrl: 'https://picksandparlays.net',
    fetchMethod: 'http',
    paths: {
      nba: '/free-picks/nba',
      nfl: '/free-picks/nfl',
      mlb: '/free-picks/mlb',
      nhl: '/free-picks/nhl',
      ncaab: '/free-picks/ncaab',
      ncaaf: '/free-picks/ncaaf',
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

    $('div.pap-content-item a[href]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      if (!href.includes('picks-and-prediction') && !href.includes('picks-and-predictions')) return;
      if (!href.includes(todayStr)) return;

      const fullUrl = href.startsWith('http') ? href : `${this.config.baseUrl}${href}`;
      if (!urls.includes(fullUrl)) urls.push(fullUrl);
    });

    return urls.slice(0, 15);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);

    // Detail page: must have h2[id$="-pick"] AND an h1 whose title parses as
    // a matchup ("Away vs Home Picks and Prediction…").  The index page also has
    // main.pap-content h1 but with a generic title like "NHL Picks and Predictions".
    const h1Text = $('main.pap-content h1, h1').first().text().trim();
    const hasPickSection = $('h2[id$="-pick"]').length > 0;
    const hasTitleMatchup = !!this.parseTitleMatchup(h1Text);

    if (hasPickSection && hasTitleMatchup) {
      return this.parseDetailPage($, sport, fetchedAt);
    }

    // Index page: extract predictions from titles
    return this.parseIndexPage($, sport, fetchedAt);
  }

  private parseIndexPage(
    $: ReturnType<typeof this.load>,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    $('div.pap-content-item').each((_i, el) => {
      const $card = $(el);
      const title = $card.find('h3').text().trim();
      const matchup = this.parseTitleMatchup(title);
      if (!matchup) return;

      const author = $card.find('span.pap-author-name').text().replace(/By:\s*/i, '').trim();
      const dateText = $card.find('span.pap-published').text().trim();
      const gameDate = this.parsePubDate(dateText) || fetchedAt.toISOString().split('T')[0]!;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup.home,
        awayTeamRaw: matchup.away,
        gameDate,
        gameTime: null,
        pickType: 'moneyline',
        side: 'home',
        value: null,
        pickerName: author || 'Picks & Parlays',
        confidence: null,
        reasoning: $card.find('div.pap-content-item-teaser p').text().trim().slice(0, 300) || null,
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
    const title = $('main.pap-content h1').first().text().trim() || $('h1').first().text().trim();
    const matchup = this.parseTitleMatchup(title);
    if (!matchup) return [];

    const author = $('meta[name="author"]').attr('content')?.trim()
      || $('span.pap-author-name a').first().text().trim()
      || 'Picks & Parlays';

    const pubTime = $('meta[property="article:published_time"]').attr('content') || '';
    const gameDate = pubTime ? pubTime.split('T')[0]! : fetchedAt.toISOString().split('T')[0]!;

    // Kim Smith format: ul li starting with "Pick:"
    $('ul li').each((_i, el) => {
      const text = $(el).text().trim();
      if (!text.startsWith('Pick:')) return;

      const pickContent = text.replace(/^Pick:\s*/i, '').trim();
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
    });

    // Eddie Kline format: prose after h2[id$="-pick"]
    if (predictions.length === 0) {
      const pickH2 = $('h2[id$="-pick"]').last();
      if (pickH2.length > 0) {
        // Collect text from siblings after the pick heading
        let pickText = '';
        pickH2.nextAll('p').each((_i, el) => {
          pickText += ' ' + $(el).text().trim();
        });

        // "Final Score Prediction, Orlando Magic win 124-113"
        const scoreMatch = pickText.match(/Final Score Prediction[,:]\s*(.+?)\s+(?:win|wins?)\s+(\d+)[- ](\d+)/i);
        if (scoreMatch) {
          const winner = scoreMatch[1]!.trim();
          const side = this.teamToSide(winner, matchup.home, matchup.away);

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: matchup.home,
            awayTeamRaw: matchup.away,
            gameDate,
            gameTime: null,
            pickType: 'moneyline',
            side,
            value: null,
            pickerName: author,
            confidence: 'medium',
            reasoning: pickText.trim().slice(0, 300),
            fetchedAt,
          });
        }

        // Also check for over/under mentions
        if (pickText.match(/goes?\s+over\s+the\s+total/i) || pickText.match(/over\s+the\s+total/i)) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: matchup.home,
            awayTeamRaw: matchup.away,
            gameDate,
            gameTime: null,
            pickType: 'over_under',
            side: 'over',
            value: null,
            pickerName: author,
            confidence: 'medium',
            reasoning: pickText.trim().slice(0, 300),
            fetchedAt,
          });
        } else if (pickText.match(/under\s+the\s+total/i)) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: matchup.home,
            awayTeamRaw: matchup.away,
            gameDate,
            gameTime: null,
            pickType: 'over_under',
            side: 'under',
            value: null,
            pickerName: author,
            confidence: 'medium',
            reasoning: pickText.trim().slice(0, 300),
            fetchedAt,
          });
        }
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

    // "Over (if total is set at 230 or lower)"
    if (lower.startsWith('over')) return { pickType: 'over_under', side: 'over', value: null };
    if (lower.startsWith('under')) return { pickType: 'over_under', side: 'under', value: null };

    // "Phoenix Suns - Spread"
    if (lower.includes('spread') || lower.includes('ats')) {
      const teamPart = text.replace(/\s*-\s*Spread.*/i, '').trim();
      const side = this.teamToSide(teamPart, matchup.home, matchup.away);
      return { pickType: 'spread', side, value: null };
    }

    // "Team Name ML" or "Team Name Moneyline"
    if (lower.includes('moneyline') || lower.includes(' ml')) {
      const teamPart = text.replace(/\s*-?\s*(Moneyline|ML).*/i, '').trim();
      const side = this.teamToSide(teamPart, matchup.home, matchup.away);
      return { pickType: 'moneyline', side, value: null };
    }

    // Default: team name pick
    const side = this.teamToSide(text, matchup.home, matchup.away);
    return { pickType: 'moneyline', side, value: null };
  }

  private parseTitleMatchup(title: string): { home: string; away: string } | null {
    const match = title.match(/^(.+?)\s+vs\.?\s+(.+?)\s+(?:Picks?\s+and|Prediction)/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
  }

  private parsePubDate(text: string): string | null {
    const match = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) return null;
    return `${match[3]}-${match[1]}-${match[2]}`;
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
