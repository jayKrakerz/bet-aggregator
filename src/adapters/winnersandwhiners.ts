import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Winners & Whiners adapter.
 *
 * WordPress site, same platform as Picks & Parlays (WagerTalk parent).
 * Server-rendered. 2-step scraping:
 * 1. Index page: div.pap-content-item with h3 title, a[href] to article
 * 2. Detail page: h2[id$="-pick"] section contains the actual pick
 *
 * Title format: "{Away} vs {Home} Picks and Prediction(s) for {Day} {Month} {Date} {Year}"
 */
export class WinnersAndWhinersAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'winnersandwhiners',
    name: 'Winners & Whiners',
    baseUrl: 'https://winnersandwhiners.com',
    fetchMethod: 'http',
    paths: {
      nba: '/free-picks/nba',
      nfl: '/free-picks/nfl',
      mlb: '/free-picks/mlb',
      nhl: '/free-picks/nhl',
      ncaab: '/free-picks/college-basketball',
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

    // Detail page
    if ($('h2[id$="-pick"], h2[id$="-picks"]').length > 0 || ($('main.pap-content h1').length > 0 && $('div.pap-content-item').length === 0)) {
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
        pickerName: author || 'Winners & Whiners',
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
      || 'Winners & Whiners';

    const pubTime = $('meta[property="article:published_time"]').attr('content') || '';
    const gameDate = pubTime ? pubTime.split('T')[0]! : fetchedAt.toISOString().split('T')[0]!;

    // Structured picks: ul li starting with "Pick:"
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
        value: null,
        pickerName: author,
        confidence: 'medium',
        reasoning: pickContent,
        fetchedAt,
      });
    });

    // Prose-based picks from h2 pick sections (both "-pick" and "-picks" ids)
    if (predictions.length === 0) {
      // First try individual pick sections (spread-pick, over-under-pick, etc.)
      $('h2[id$="-pick"]').each((_i, el) => {
        const h2text = $(el).text().trim();
        let pickText = '';
        $(el).nextAll('p').each((_j, p) => {
          pickText += ' ' + $(p).text().trim();
        });
        pickText = pickText.trim();
        if (!pickText) return;

        // "Final Score Prediction: X wins 118-111"
        const scoreMatch = pickText.match(/Final Score Prediction[,:]\s*(.+?)\s+(?:win|wins?)\s+(\d+)[- ](\d+)/i);
        if (scoreMatch) {
          const side = this.teamToSide(scoreMatch[1]!.trim(), matchup.home, matchup.away);
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
            reasoning: pickText.slice(0, 300),
            fetchedAt,
          });
          return;
        }

        // Determine pick type from h2 heading
        const h2lower = h2text.toLowerCase();
        let pickType: RawPrediction['pickType'] = 'moneyline';
        if (h2lower.includes('spread')) pickType = 'spread';
        else if (h2lower.includes('over') || h2lower.includes('under') || h2lower.includes('total') || h2lower.includes('o/u')) pickType = 'over_under';

        // Prose pick patterns: "Take X to cover" / "Take the over/under"
        const pickLower = pickText.toLowerCase();
        let side: Side = 'home';

        if (pickType === 'over_under') {
          if (/take\s+(?:the\s+)?over|lean(?:ing)?\s+(?:toward\s+)?(?:the\s+)?over|like\s+(?:the\s+)?over/i.test(pickText)) {
            side = 'over';
          } else if (/take\s+(?:the\s+)?under|lean(?:ing)?\s+(?:toward\s+)?(?:the\s+)?under|like\s+(?:the\s+)?under/i.test(pickText)) {
            side = 'under';
          } else {
            // Default: check if "over" or "under" appears more prominently
            side = pickLower.lastIndexOf('over') > pickLower.lastIndexOf('under') ? 'over' : 'under';
          }
        } else if (pickType === 'spread') {
          // "Take Milwaukee to cover" — anchor with "to cover" or spread value
          const coverMatch = pickText.match(/[Tt]ake\s+(?:the\s+)?(\w[\w\s]{1,30}?)\s+to\s+cover/);
          if (coverMatch) {
            side = this.teamToSide(coverMatch[1]!.trim(), matchup.home, matchup.away);
          } else {
            // "Back the Bucks +3.5"
            const spreadMatch = pickText.match(/(?:[Tt]ake|[Bb]ack|[Ll]ike|[Pp]ick)\s+(?:the\s+)?(\w[\w\s]{1,30}?)\s+([-+][\d.]+)/);
            if (spreadMatch) {
              side = this.teamToSide(spreadMatch[1]!.trim(), matchup.home, matchup.away);
            }
          }
        } else {
          // Moneyline — look for "Take X to win" or "Take X on the moneyline"
          const mlMatch = pickText.match(/[Tt]ake\s+(?:the\s+)?(\w[\w\s]{1,30}?)\s+(?:to\s+win|on\s+(?:the\s+)?moneyline|at\s+home|on\s+the\s+road)/);
          if (mlMatch) {
            side = this.teamToSide(mlMatch[1]!.trim(), matchup.home, matchup.away);
          }
        }

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: matchup.home,
          awayTeamRaw: matchup.away,
          gameDate,
          gameTime: null,
          pickType,
          side,
          value: null,
          pickerName: author,
          confidence: 'medium',
          reasoning: pickText.slice(0, 300),
          fetchedAt,
        });
      });

      // Fallback: combined "-picks" section (e.g., "rockets-vs-spurs-picks")
      // These contain multiple picks in a single prose block
      if (predictions.length === 0) {
        $('h2[id$="-picks"]').each((_i, el) => {
          const h2id = $(el).attr('id') || '';
          // Skip generic "-picks" that are just the title (e.g., "orlando-magic-vs-milwaukee-bucks-picks")
          // Those are handled by the individual "-pick" sections above
          if ($(`h2[id$="-pick"]`).length > 0) return;

          let pickText = '';
          $(el).nextAll('p').each((_j, p) => {
            pickText += ' ' + $(p).text().trim();
          });
          pickText = pickText.trim();
          if (!pickText) return;

          // Spread pick: "Take X to cover" / "Take X +/-N"
          const coverMatch = pickText.match(/[Tt]ake\s+(?:the\s+)?(\w[\w\s]{1,30}?)\s+to\s+cover/);
          if (coverMatch) {
            predictions.push({
              sourceId: this.config.id,
              sport,
              homeTeamRaw: matchup.home,
              awayTeamRaw: matchup.away,
              gameDate,
              gameTime: null,
              pickType: 'spread',
              side: this.teamToSide(coverMatch[1]!.trim(), matchup.home, matchup.away),
              value: null,
              pickerName: author,
              confidence: 'medium',
              reasoning: pickText.slice(0, 300),
              fetchedAt,
            });
          }

          // Over/under pick
          if (/take\s+(?:the\s+)?over|lean(?:ing)?\s+(?:toward\s+)?(?:the\s+)?over|push.*(?:over|past)\s+the\s+total/i.test(pickText)) {
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
              reasoning: pickText.slice(0, 300),
              fetchedAt,
            });
          } else if (/take\s+(?:the\s+)?under|lean(?:ing)?\s+(?:toward\s+)?(?:the\s+)?under|don.?t\s+expect.*score\s+enough.*over\s+the\s+total/i.test(pickText)) {
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
              reasoning: pickText.slice(0, 300),
              fetchedAt,
            });
          }
        });
      }
    }

    return predictions;
  }

  private parsePickContent(text: string, matchup: { home: string; away: string }): {
    pickType: RawPrediction['pickType'];
    side: Side;
  } {
    const lower = text.toLowerCase();
    if (lower.startsWith('over')) return { pickType: 'over_under', side: 'over' };
    if (lower.startsWith('under')) return { pickType: 'over_under', side: 'under' };
    if (lower.includes('spread') || lower.includes('ats')) {
      const teamPart = text.replace(/\s*-\s*Spread.*/i, '').trim();
      return { pickType: 'spread', side: this.teamToSide(teamPart, matchup.home, matchup.away) };
    }
    return { pickType: 'moneyline', side: this.teamToSide(text, matchup.home, matchup.away) };
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
