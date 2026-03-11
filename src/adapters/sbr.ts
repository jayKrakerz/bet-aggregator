import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Sportsbook Review (SBR) adapter.
 *
 * Server-rendered Bootstrap 5 site. Two data sources:
 * 1. Inline pick cards: div.picks-card with SportsEvent JSON-LD
 * 2. Article links: a._ArticleCard-title for detailed picks
 *
 * Pick cards have:
 *   div.picks-card-header .teams-component  - team abbreviations + logos
 *   div.pick-cards-expert-component         - expert pick details
 *     span._badge                           - pick type badge
 *     div.fw-bold.small                     - pick text ("Booker o5.5 Total Assists (-114)")
 *     .card-text a                          - expert name
 *
 * JSON-LD SportsEvent has full team names.
 */
export class SbrAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'sbr',
    name: 'Sportsbook Review',
    baseUrl: 'https://www.sportsbookreview.com',
    fetchMethod: 'http',
    paths: {
      nba: '/picks/nba/',
      nfl: '/picks/nfl/',
      mlb: '/picks/mlb/',
      nhl: '/picks/nhl/',
      ncaab: '/picks/ncaa-basketball/',
    },
    cron: '0 0 9,13,17,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  discoverUrls(html: string, _sport: string): string[] {
    const $ = this.load(html);
    const urls: string[] = [];

    // Article links: relative paths like /picks/nba/suns-vs-kings-player-props-march-3-2026/
    $('a[href*="/picks/"]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      // Only relative paths (skip full URLs which are category nav links)
      if (href.startsWith('http')) return;
      // Must have an article slug (at least 3 segments: /picks/nba/article-slug/)
      const parts = href.split('/').filter(Boolean);
      if (parts.length < 3) return;
      // Skip non-article pages
      if (href.includes('/page/') || href.includes('injury-update') || href.includes('odds-schedule')) return;
      // Prefer today's content: player-props, best-bets, play-of-the-day
      if (!href.includes('props') && !href.includes('best-bet') && !href.includes('play-of-the-day') && !href.includes('prediction')) return;
      const fullUrl = `${this.config.baseUrl}${href}`;
      if (!urls.includes(fullUrl)) urls.push(fullUrl);
    });

    return urls.slice(0, 12);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Parse JSON-LD for game metadata
    const games = this.parseJsonLd($);

    // Parse inline pick cards
    this.parsePickCards($, games, sport, fetchedAt, predictions);

    // Parse article detail pages
    if ($('article, .article-content').length > 0) {
      this.parseArticlePage($, games, sport, fetchedAt, predictions);
    }

    return predictions;
  }

  private parseJsonLd($: ReturnType<typeof this.load>): Map<string, { home: string; away: string; date: string }> {
    const games = new Map<string, { home: string; away: string; date: string }>();

    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const data = JSON.parse($(el).html() || '{}');
        if (data['@type'] === 'SportsEvent' && data.homeTeam && data.awayTeam) {
          const id = data.identifier || '';
          games.set(id, {
            home: data.homeTeam.name || '',
            away: data.awayTeam.name || '',
            date: data.startDate ? data.startDate.split('T')[0] : '',
          });
        }
      } catch { /* skip invalid JSON */ }
    });

    return games;
  }

  private parsePickCards(
    $: ReturnType<typeof this.load>,
    games: Map<string, { home: string; away: string; date: string }>,
    sport: string,
    fetchedAt: Date,
    predictions: RawPrediction[],
  ): void {
    $('div.picks-card').each((_i, el) => {
      const $card = $(el);
      const gameId = $card.attr('id') || '';
      const game = games.get(gameId);

      // Get team names from JSON-LD or card header
      let home = game?.home || '';
      let away = game?.away || '';
      const gameDate = game?.date || fetchedAt.toISOString().split('T')[0]!;

      if (!home || !away) {
        // Fallback: extract from header
        const teams = $card.prev('.picks-card-header').find('.teams-component');
        if (teams.length >= 2) {
          const awayImg = $(teams[0]).find('img');
          const homeImg = $(teams[1]).find('img');
          away = awayImg.attr('alt')?.replace(/\s*logo$/i, '').trim() || $(teams[0]).text().trim();
          home = homeImg.attr('alt')?.replace(/\s*logo$/i, '').trim() || $(teams[1]).text().trim();
        }
      }

      if (!home || !away) return;

      // Parse each expert pick within this card
      $card.find('.pick-cards-expert-component').each((_j, pickEl) => {
        const $pick = $(pickEl);
        const pickType = $pick.find('._badge._badge-sm').text().trim();
        const pickText = $pick.find('.fw-bold.small, div.fw-bold').text().trim();
        const expert = $pick.find('.card-text a').text().trim();

        if (!pickText) return;

        const parsed = this.parsePickText(pickText, { home, away });

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate,
          gameTime: null,
          pickType: parsed.pickType,
          side: parsed.side,
          value: parsed.value,
          pickerName: expert || 'SBR Expert',
          confidence: 'medium',
          reasoning: pickType ? `${pickType}: ${pickText}` : pickText,
          fetchedAt,
        });
      });
    });
  }

  private parseArticlePage(
    $: ReturnType<typeof this.load>,
    _games: Map<string, { home: string; away: string; date: string }>,
    sport: string,
    fetchedAt: Date,
    predictions: RawPrediction[],
  ): void {
    const title = $('h1').first().text().trim();
    const matchup = this.parseTitleMatchup(title);
    if (!matchup) return;

    const author = $('.article-author .author-name, meta[name="author"]').first().text().trim()
      || $('meta[name="author"]').attr('content')?.trim() || 'SBR';

    const dateText = $('meta[property="article:published_time"]').attr('content') || '';
    const gameDate = dateText ? dateText.split('T')[0]! : fetchedAt.toISOString().split('T')[0]!;

    // Parse picks from tables
    $('table tbody tr').each((_i, el) => {
      const cells = $(el).find('td');
      if (cells.length < 2) return;

      const playerOrPick = $(cells[0]).text().trim();
      const pickText = $(cells[1]).text().trim();
      if (!pickText) return;

      const parsed = this.parsePickText(pickText, matchup);

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
        reasoning: `${playerOrPick}: ${pickText}`,
        fetchedAt,
      });
    });
  }

  private parsePickText(text: string, matchup: { home: string; away: string }): {
    pickType: RawPrediction['pickType'];
    side: Side;
    value: number | null;
  } {
    // Prop: "Devin Booker o5.5 Total Assists (-114)"
    const propMatch = text.match(/[ou]([\d.]+)\s+(.+?)\s+\(([+-]\d+)\)/i);
    if (propMatch) {
      const side = text.match(/^.+?o[\d.]/i) ? 'over' : 'under';
      return { pickType: 'prop', side: side as Side, value: parseFloat(propMatch[1]!) };
    }

    // Over/Under
    const ouMatch = text.match(/(over|under)\s+([\d.]+)/i);
    if (ouMatch) {
      return {
        pickType: 'over_under',
        side: ouMatch[1]!.toLowerCase() === 'over' ? 'over' : 'under',
        value: parseFloat(ouMatch[2]!),
      };
    }

    // Spread: "Team -3.5"
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
    const match = title.match(/(.+?)\s+vs\.?\s+(.+?)(?:\s+(?:Pick|Prediction|Player|Props|Best))/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
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
