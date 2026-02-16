import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side } from '../types/prediction.js';

/**
 * OddsShark adapter.
 *
 * OddsShark's /nba/computer-picks page is a Drupal-rendered page (NOT a React SPA)
 * with three data sections:
 *
 * 1. **Computer Picks** — one `.computer-picks-event-container` per game,
 *    each containing spread/moneyline/total picks. The `highlighted-pick` class
 *    on a child div marks which side the computer picks.
 *
 * 2. **Expert Picks** — `.expert-pick` cards with free-form headlines
 *    (mostly player props like "Anthony Edwards 2+ Made Threes").
 *
 * 3. **Same Game Parlays** — `.same-game-parlays__node` (lower priority).
 *
 * The page also contains JSON-LD `SportsEvent[]` with clean home/away metadata.
 */
export class OddSharkAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'oddshark',
    name: 'OddsShark',
    baseUrl: 'https://www.oddsshark.com',
    fetchMethod: 'browser',
    paths: { nba: '/nba/computer-picks' },
    cron: '0 0 10,14,18,22 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for computer picks to render
    await page.waitForSelector(
      '.computer-picks-event-container',
      { timeout: 15000 },
    ).catch(() => {
      // May not exist on off-days; parse whatever loaded
    });

    // Scroll to trigger any lazy-loaded content
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Build event ID → metadata map from JSON-LD SportsEvent data
    const eventMeta = this.parseJsonLdEvents($);

    // Parse date group headers: `.picks-event-date > span` → "Thursday, February 19"
    // We'll map each container to its preceding date header
    let currentDate = '';

    $('.computer-picks-content').children().each((_i, el) => {
      const $el = $(el);

      // Date group header
      if ($el.hasClass('picks-event-date')) {
        currentDate = this.parseDateHeader($el.find('span').text().trim(), fetchedAt);
        return;
      }

      // Computer pick container
      if (!$el.hasClass('computer-picks-event-container')) return;

      const eventId = $el.attr('data-event-id') || '';
      const meta = eventMeta.get(eventId);
      const gameTime = $el.find('.event-time').text().trim() || null;

      // Team names: .team-names contains <span>Away</span> VS <span>Home</span>
      const teamSpans = $el.find('.team-names > span');
      const awayTeamRaw = teamSpans.first().text().trim();
      const homeTeamRaw = teamSpans.last().text().trim();

      if (!homeTeamRaw || !awayTeamRaw) return;

      // Use JSON-LD date if available, else fall back to parsed header
      const gameDate = meta?.date || currentDate;

      // --- Spread pick ---
      const spreadPick = this.parsePickColumn($, $el, '.spread-pick');
      if (spreadPick) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'spread',
          side: spreadPick.side,
          value: spreadPick.value,
          pickerName: 'OddsShark Computer',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      }

      // --- Moneyline pick ---
      const mlPick = this.parseMoneylineColumn($, $el);
      if (mlPick) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'moneyline',
          side: mlPick.side,
          value: mlPick.value,
          pickerName: 'OddsShark Computer',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      }

      // --- Total (over/under) pick ---
      const totalPick = this.parsePickColumn($, $el, '.total-pick');
      if (totalPick) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType: 'over_under',
          side: totalPick.side,
          value: totalPick.value,
          pickerName: 'OddsShark Computer',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      }
    });

    // --- Expert picks (prop bets) ---
    this.parseExpertPicks($, sport, eventMeta, fetchedAt, predictions);

    return predictions;
  }

  /**
   * Parse spread or total pick columns.
   * Structure: div.spread-pick (or .total-pick) > div children:
   *   [0] = label ("Spread Pick" / "Total Pick")
   *   [1] = away/over row
   *   [2] = home/under row
   * The row with class `highlighted-pick` is the computer's pick.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parsePickColumn(
    $: ReturnType<typeof this.load>,
    container: any,
    selector: string,
  ): { side: Side; value: number | null } | null {
    const col = $(container).find(selector);
    if (!col.length) return null;

    const rows = col.children('div');
    // rows[0] = label, rows[1] = away/over, rows[2] = home/under
    if (rows.length < 3) return null;

    const isTotal = selector === '.total-pick';
    const row1 = $(rows[1]);
    const row2 = $(rows[2]);

    let pickedRow: ReturnType<typeof $> | null = null;
    let side: Side;

    if (row1.hasClass('highlighted-pick')) {
      pickedRow = row1;
      side = isTotal ? 'over' : 'away';
    } else if (row2.hasClass('highlighted-pick')) {
      pickedRow = row2;
      side = isTotal ? 'under' : 'home';
    } else {
      return null; // No pick made (game not yet computed)
    }

    const valueText = pickedRow.find('.highlighted-text').first().text().trim();
    // Spread: "-2.5" or "+2.5"; Total: "O 234.5" or "U 234.5"
    const numMatch = valueText.match(/[+-]?\d+\.?\d*/);
    const value = numMatch ? parseFloat(numMatch[0]) : null;

    return { side, value };
  }

  /**
   * Parse the moneyline / predicted score column.
   * Structure: div.predicted-score > div children:
   *   [0] = label ("Predicted Score / ML")
   *   [1+] = team rows (away first, home second)
   * The row with `highlighted-pick` is the computer's ML pick.
   * Inside each row: .best-odds-book-wrapper.moneyline span:nth-child(2) = odds
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseMoneylineColumn(
    $: ReturnType<typeof this.load>,
    container: any,
  ): { side: Side; value: number | null } | null {
    const col = $(container).find('.predicted-score');
    if (!col.length) return null;

    // Get non-label child divs (skip .desktop-only and .mobile-only labels)
    const rows = col.children('div').not('.desktop-only').not('.mobile-only');
    if (rows.length < 2) return null;

    const awayRow = $(rows[0]);
    const homeRow = $(rows[1]);

    let side: Side;
    let pickedRow: ReturnType<typeof $>;

    if (awayRow.hasClass('highlighted-pick')) {
      side = 'away';
      pickedRow = awayRow;
    } else if (homeRow.hasClass('highlighted-pick')) {
      side = 'home';
      pickedRow = homeRow;
    } else {
      return null;
    }

    // Odds are in the second <span> inside .best-odds-book-wrapper.moneyline
    const oddsText = pickedRow
      .find('.best-odds-book-wrapper.moneyline span')
      .not('.highlighted-text')
      .not('.img-placeholder')
      .first()
      .text()
      .trim();
    const oddsMatch = oddsText.match(/[+-]?\d+/);
    const value = oddsMatch ? parseFloat(oddsMatch[0]) : null;

    return { side, value };
  }

  /**
   * Parse expert pick cards: `.expert-pick.expert-picks-slider__row`
   * These are typically player prop bets with free-form headlines.
   */
  private parseExpertPicks(
    $: ReturnType<typeof this.load>,
    sport: string,
    eventMeta: Map<string, { date: string; home: string; away: string }>,
    fetchedAt: Date,
    predictions: RawPrediction[],
  ): void {
    $('.expert-pick.expert-picks-slider__row').each((_i, el) => {
      const card = $(el);
      const gameId = card.attr('data-game-id') || '';
      const meta = eventMeta.get(gameId);

      const headline = card.find('.expert-pick-headline').text().trim();
      if (!headline) return;

      const oddsText = card.find('.expert-pick-odds').text().trim();
      const oddsMatch = oddsText.match(/[+-]?\d+/);
      const value = oddsMatch ? parseFloat(oddsMatch[0]) : null;

      const author =
        card.find('.expert-pick-author-wrapper a').text().trim() ||
        'OddsShark Expert';

      // Extract team names from JSON-LD metadata or matchup link
      let homeTeamRaw = meta?.home || '';
      let awayTeamRaw = meta?.away || '';
      const gameDate = meta?.date || '';

      if (!homeTeamRaw) {
        // Fall back to parsing the matchup link URL
        const matchupHref = card.find('.expert-pick-see-matchup').attr('href') || '';
        const teamsMatch = matchupHref.match(/\/nba\/(.+?)-odds/);
        if (teamsMatch) {
          const parts = teamsMatch[1]!.split('-');
          // URL format: away-home-odds-date-year-eventid
          // But team names can be multi-word so we can't reliably split
          awayTeamRaw = parts[0] || '';
          homeTeamRaw = parts[1] || '';
        }
      }

      // Determine pick type from headline
      const pickType = this.inferExpertPickType(headline);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate,
        gameTime: null,
        pickType,
        side: 'home', // Props don't have a traditional side
        value,
        pickerName: author,
        confidence: null,
        reasoning: headline,
        fetchedAt,
      });
    });
  }

  /**
   * Infer pick type from expert pick headline text.
   * Most are player props like "Anthony Edwards 2+ Made Threes".
   */
  private inferExpertPickType(headline: string): PickType {
    const lower = headline.toLowerCase();
    if (/over|under|total/i.test(lower)) return 'over_under';
    if (/spread|[+-]\d+\.?\d*\s*$/i.test(lower)) return 'spread';
    if (/moneyline|ml\b/i.test(lower)) return 'moneyline';
    // Most expert picks on OddsShark are player props
    if (/\d\+|points|assists|rebounds|threes|steals|blocks|made/i.test(lower)) return 'prop';
    return 'moneyline';
  }

  /**
   * Parse JSON-LD SportsEvent data into an event ID → metadata map.
   * JSON-LD blocks: `script[type="application/ld+json"]`
   */
  private parseJsonLdEvents(
    $: ReturnType<typeof this.load>,
  ): Map<string, { date: string; home: string; away: string }> {
    const map = new Map<string, { date: string; home: string; away: string }>();

    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const data: unknown = JSON.parse($(el).html() || '');
        const items = Array.isArray(data) ? data : [data];

        for (const item of items) {
          if (
            typeof item !== 'object' || item === null ||
            !('url' in item) || !('homeTeam' in item) || !('awayTeam' in item)
          ) continue;

          const ev = item as {
            url?: string;
            startDate?: string;
            homeTeam?: { name?: string };
            awayTeam?: { name?: string };
          };

          // Extract event ID from URL: /nba/away-home-odds-date-year-EVENTID
          const idMatch = ev.url?.match(/(\d+)$/);
          if (!idMatch) continue;

          const eventId = idMatch[1]!;
          const date = ev.startDate?.split('T')[0] || '';
          const home = ev.homeTeam?.name || '';
          const away = ev.awayTeam?.name || '';

          if (eventId && (home || away)) {
            map.set(eventId, { date, home, away });
          }
        }
      } catch {
        // Ignore malformed JSON-LD
      }
    });

    return map;
  }

  /**
   * Parse date from header text like "Thursday, February 19" into "YYYY-MM-DD".
   * Uses fetchedAt's year since the header doesn't include the year.
   */
  private parseDateHeader(text: string, fetchedAt: Date): string {
    const match = text.match(
      /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+(\w+)\s+(\d{1,2})/i,
    );
    if (!match) return fetchedAt.toISOString().split('T')[0]!;

    const months: Record<string, string> = {
      january: '01', february: '02', march: '03', april: '04',
      may: '05', june: '06', july: '07', august: '08',
      september: '09', october: '10', november: '11', december: '12',
    };
    const m = months[match[1]!.toLowerCase()];
    const d = match[2]!.padStart(2, '0');
    if (!m) return fetchedAt.toISOString().split('T')[0]!;

    return `${fetchedAt.getFullYear()}-${m}-${d}`;
  }
}
