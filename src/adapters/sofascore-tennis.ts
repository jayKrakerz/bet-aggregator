import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * SofaScore Tennis adapter (sofascore.com/tennis).
 *
 * STATUS: WORKING - DOM uses Panda CSS utility classes and `bdi` elements.
 * `__NEXT_DATA__` has `initialState` but no events array directly.
 * Match data is in the rendered DOM inside `[class*="event-hl-"]` anchor
 * elements (href like `/tennis/match/...`). Each contains `bdi` elements:
 *   bdi[0] = time (e.g. "18:00"), bdi[1] = status ("FT", "-"),
 *   bdi[2] = player1, bdi[3] = player2 (or score if match is live/finished).
 * Score elements have class containing "score".
 */
export class SofascoreTennisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'sofascore-tennis',
    name: 'SofaScore Tennis',
    baseUrl: 'https://www.sofascore.com',
    fetchMethod: 'browser',
    paths: {
      tennis: '/tennis',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 8000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for event elements to render (Panda CSS utility class pattern)
    await page.waitForSelector('[class*="event-hl-"]', {
      timeout: 15000,
    }).catch(() => {});
    await page.waitForTimeout(3000);
    // Scroll to load more events
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Try __NEXT_DATA__ first for structured event data
    const nextData = $('#__NEXT_DATA__').html();
    if (nextData) {
      try {
        const data = JSON.parse(nextData);
        const events = data?.props?.pageProps?.events
          || data?.props?.pageProps?.initialEvents
          || [];
        for (const event of events) {
          const pred = this.parseEvent(event, sport, fetchedAt);
          if (pred) predictions.push(pred);
        }
        if (predictions.length > 0) return predictions;
      } catch {
        // Fall through to DOM parsing
      }
    }

    // DOM parsing: SofaScore renders match events as <a> elements with
    // class names like "event-hl-{id}". Each contains <bdi> elements:
    //   bdi[0] = time (e.g. "18:00")
    //   bdi[1] = status (e.g. "FT", "-")
    //   bdi[2] = player1 name
    //   bdi[3] = player2 name
    $('[class*="event-hl-"]').each((_i, el) => {
      const $cell = $(el);
      const href = $cell.attr('href') || '';
      // Only process tennis match links
      if (!href.includes('/tennis/match/')) return;

      const bdiEls = $cell.find('bdi');
      if (bdiEls.length < 4) return;

      const timeText = $(bdiEls[0]).text().trim();
      const status = $(bdiEls[1]).text().trim();
      const player1 = $(bdiEls[2]).text().trim();
      const player2 = $(bdiEls[3]).text().trim();

      if (!player1 || !player2) return;
      // Skip finished matches (FT = Full Time)
      if (status === 'FT' || status === 'Finished') return;

      // Extract time in HH:MM format
      const timeMatch = timeText.match(/(\d{1,2}:\d{2})/);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: player1,
        awayTeamRaw: player2,
        gameDate: fetchedAt.toISOString().split('T')[0]!,
        gameTime: timeMatch ? timeMatch[1]! : null,
        pickType: 'moneyline',
        side: 'home',
        value: null,
        pickerName: 'SofaScore',
        confidence: null,
        reasoning: null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseEvent(
    event: Record<string, unknown>,
    sport: string,
    fetchedAt: Date,
  ): RawPrediction | null {
    const home = event.homeTeam as Record<string, string> | undefined;
    const away = event.awayTeam as Record<string, string> | undefined;
    if (!home?.name || !away?.name) return null;

    const startTimestamp = event.startTimestamp as number | undefined;
    let gameDate = fetchedAt.toISOString().split('T')[0]!;
    let gameTime: string | null = null;
    if (startTimestamp) {
      const d = new Date(startTimestamp * 1000);
      gameDate = d.toISOString().split('T')[0]!;
      const hours = d.getUTCHours();
      const mins = d.getUTCMinutes();
      if (hours !== 0 || mins !== 0) {
        const period = hours >= 12 ? 'PM' : 'AM';
        const h = hours % 12 || 12;
        gameTime = `${h}:${mins.toString().padStart(2, '0')} ${period}`;
      }
    }

    // SofaScore vote data
    const vote = event.vote as Record<string, number> | undefined;
    const p1Vote = vote?.vote1 || 0;
    const p2Vote = vote?.vote2 || 0;
    const side: Side = p1Vote >= p2Vote ? 'home' : 'away';
    const maxVote = Math.max(p1Vote, p2Vote);
    const totalVotes = p1Vote + p2Vote + (vote?.voteX || 0);
    const winPct = totalVotes > 0 ? Math.round((maxVote / totalVotes) * 100) : 0;

    return {
      sourceId: this.config.id,
      sport,
      homeTeamRaw: home.name,
      awayTeamRaw: away.name,
      gameDate,
      gameTime,
      pickType: 'moneyline',
      side,
      value: null,
      pickerName: 'SofaScore Community',
      confidence: winPct >= 75 ? 'high' : winPct >= 55 ? 'medium' : winPct > 0 ? 'low' : null,
      reasoning: totalVotes > 0 ? `Community vote: ${winPct}% (${totalVotes} votes)` : null,
      fetchedAt,
    };
  }
}
