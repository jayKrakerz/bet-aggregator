import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side } from '../types/prediction.js';

/**
 * OneMillionPredictions adapter.
 *
 * WordPress site using Ninja Tables / FooTable for rendering prediction tables.
 * Each prediction type (1X2, Goals, BTTS, Corners, Cards, Correct Score, HT/FT)
 * is on a separate page. The homepage is 1X2. Navigation links in a table
 * (`footable_567`-like) point to each sub-page.
 *
 * Prediction rows: the cell containing `<span class="predictions-odds">` is the pick.
 * League headers: first td has `colspan="2"` with black background.
 * Teams: separated by `<br>` in the teams cell (home first, away second).
 * Kick-off: `<p class="fulldatetime">DD/MM HH:MM</p>`.
 */
export class OneMillionPredictionsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'onemillionpredictions',
    name: 'OneMillionPredictions',
    baseUrl: 'https://onemillionpredictions.com',
    fetchMethod: 'browser',
    paths: { football: '/' },
    cron: '0 0 8,12,16,20 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('.ninja_footable', { timeout: 15000 }).catch(() => {
      // Tables may not render on some pages
    });
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
  }

  /**
   * Discover sub-page URLs from the navigation table.
   * The nav table contains links to all prediction type pages.
   * The current page is rendered as plain text (no <a> tag).
   * Premium is excluded.
   */
  discoverUrls(html: string, _sport: string): string[] {
    const $ = this.load(html);
    const urls: string[] = [];
    const baseUrl = this.config.baseUrl;

    // The navigation table has columns: 1x2 | Goals | Corners | Cards (row 1)
    //                                   Score | BTTS | HT/FT | Premium (row 2)
    // Find all anchor tags in small navigation tables (not the main predictions table)
    $('table.ninja_footable').each((_i, table) => {
      const $table = $(table);
      const headers = $table.find('thead th');
      // Nav table has columns like "1x2", "Goals", "Corners", "Cards"
      const headerTexts = headers.map((_j, th) => $(th).text().trim().toLowerCase()).get();
      const isNavTable = headerTexts.some(
        (t) => t === '1x2' || t === 'goals' || t === 'corners',
      );
      if (!isNavTable) return;

      $table.find('tbody a').each((_j, a) => {
        const href = $(a).attr('href');
        if (!href) return;
        const text = $(a).text().trim().toLowerCase();
        // Skip premium
        if (text === 'premium') return;
        // Normalize to absolute URL
        const url = href.startsWith('http') ? href : `${baseUrl}${href}`;
        // Skip the homepage (it's already the landing page being parsed)
        const urlPath = new URL(url).pathname;
        if (urlPath === '/' || urlPath === '') return;
        urls.push(url);
      });
    });

    return urls;
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const pageType = this.detectPageType($);

    // Find the main prediction table — it's the largest ninja_footable with prediction rows
    let mainTable: ReturnType<typeof $> | null = null;
    let maxRows = 0;

    $('table.ninja_footable').each((_i, table) => {
      const $table = $(table);
      const rowCount = $table.find('tbody tr').length;
      // Main table has many rows and has the fulldatetime or predictions-odds content
      if (
        rowCount > maxRows &&
        ($table.find('.fulldatetime').length > 0 ||
          $table.find('.predictions-odds').length > 0)
      ) {
        maxRows = rowCount;
        mainTable = $table;
      }
    });

    if (!mainTable) return predictions;

    let currentLeague = '';

    (mainTable as ReturnType<typeof $>).find('tbody tr').each((_i, row) => {
      const $row = $(row);
      const firstTd = $row.find('td').first();

      // League header: first td has colspan="2"
      if (firstTd.attr('colspan') === '2') {
        currentLeague = firstTd.text().trim();
        return;
      }

      // Prediction row: must have teams cell and a predictions-odds span
      const teamsCell = $row.find('.ninja_clmn_nm_teams');
      const oddsSpan = $row.find('.predictions-odds');
      if (!teamsCell.length || !oddsSpan.length) return;

      // Extract teams (home first, away second, separated by <br>)
      const teamsHtml = teamsCell.html() || '';
      const teamParts = teamsHtml
        .split(/<br\s*\/?>/i)
        .map((t) => t.replace(/<[^>]*>/g, '').trim())
        .filter(Boolean);
      if (teamParts.length < 2) return;
      const homeTeamRaw = teamParts[0]!;
      const awayTeamRaw = teamParts[1]!;

      // Extract kick-off date and time
      const kickOffText = $row.find('.fulldatetime').text().trim();
      const { gameDate, gameTime } = this.parseKickOff(kickOffText, fetchedAt);

      // Determine which column the prediction is in
      const oddsCell = oddsSpan.closest('td');
      const oddsValue = parseFloat(oddsSpan.text().trim()) || null;

      // For goals/corners/cards pages, extract the line from the ninja_clmn_nm_1 column
      // (e.g., "2.5" for Over/Under 2.5 goals, "10.5" for corners)
      let line: number | null = null;
      if (pageType === 'goals' || pageType === 'corners' || pageType === 'cards') {
        const lineCell = $row.find('.ninja_clmn_nm_1');
        if (lineCell.length) {
          line = parseFloat(lineCell.text().trim()) || null;
        }
      }

      // Map column class to side based on page type
      const result = this.mapPrediction($, oddsCell, pageType, oddsValue, line);
      if (!result) return;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate,
        gameTime,
        pickType: result.pickType,
        side: result.side,
        value: result.value,
        pickerName: 'OneMillionPredictions',
        confidence: null,
        reasoning: currentLeague || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  /**
   * Detect the page type from the HTML title or table headers.
   */
  private detectPageType(
    $: ReturnType<typeof this.load>,
  ): '1x2' | 'goals' | 'btts' | 'corners' | 'cards' | 'correct-score' | 'ht-ft' {
    const title = $('title').text().toLowerCase();

    if (title.includes('both teams to score') || title.includes('btts')) return 'btts';
    if (title.includes('goals') || title.includes('over')) return 'goals';
    if (title.includes('corner')) return 'corners';
    if (title.includes('card')) return 'cards';
    if (title.includes('correct score') || title.includes('correct-score')) return 'correct-score';
    if (title.includes('ht') && title.includes('ft')) return 'ht-ft';
    if (title.includes('half time') || title.includes('half-time')) return 'ht-ft';

    // Default: homepage is 1X2
    return '1x2';
  }

  /**
   * Map a prediction cell to pickType + side based on page type and column class.
   * For over/under pages (goals, corners, cards), the `line` param carries the
   * threshold (e.g. 2.5 goals, 10.5 corners) extracted from the ninja_clmn_nm_1 column.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapPrediction(
    $: ReturnType<typeof this.load>,
    oddsCell: any,
    pageType: string,
    oddsValue: number | null,
    line: number | null = null,
  ): { pickType: PickType; side: Side; value: number | null } | null {
    const classes = ($(oddsCell).attr('class') || '').toLowerCase();

    switch (pageType) {
      case '1x2': {
        // Columns: ninja_clmn_nm_1 (home), ninja_clmn_nm_x (draw), ninja_clmn_nm_2 (away)
        if (classes.includes('ninja_clmn_nm_1')) return { pickType: 'moneyline', side: 'home', value: oddsValue };
        if (classes.includes('ninja_clmn_nm_x')) return { pickType: 'moneyline', side: 'draw', value: oddsValue };
        if (classes.includes('ninja_clmn_nm_2')) return { pickType: 'moneyline', side: 'away', value: oddsValue };
        return null;
      }

      case 'goals': {
        // Columns: Line (ninja_clmn_nm_1) | Over (ninja_clmn_nm_x) | Under (ninja_clmn_nm_2)
        // Use the line value (e.g. 2.5) instead of odds for the value field
        if (classes.includes('ninja_clmn_nm_x')) {
          return { pickType: 'over_under', side: 'over', value: line };
        }
        if (classes.includes('ninja_clmn_nm_2')) {
          return { pickType: 'over_under', side: 'under', value: line };
        }
        // Fall back to column index
        const cellIndex = $(oddsCell).index();
        if (cellIndex <= 3) return { pickType: 'over_under', side: 'over', value: line };
        return { pickType: 'over_under', side: 'under', value: line };
      }

      case 'btts': {
        // Columns: BTTS label | Yes | No
        // ninja_clmn_nm_x = Yes, ninja_clmn_nm_2 = No
        if (classes.includes('ninja_clmn_nm_x')) return { pickType: 'prop', side: 'yes', value: oddsValue };
        if (classes.includes('ninja_clmn_nm_2')) return { pickType: 'prop', side: 'no', value: oddsValue };
        // Fall back to column index
        const cellIdx = $(oddsCell).index();
        if (cellIdx === 3) return { pickType: 'prop', side: 'yes', value: oddsValue };
        return { pickType: 'prop', side: 'no', value: oddsValue };
      }

      case 'corners':
      case 'cards': {
        // Columns: Line (ninja_clmn_nm_1) | Over (ninja_clmn_nm_x) | Under (ninja_clmn_nm_2)
        // Use the line value (e.g. 10.5 corners) instead of odds
        if (classes.includes('ninja_clmn_nm_x')) {
          return { pickType: 'prop', side: 'over', value: line };
        }
        if (classes.includes('ninja_clmn_nm_2')) {
          return { pickType: 'prop', side: 'under', value: line };
        }
        const idx = $(oddsCell).index();
        if (idx <= 3) return { pickType: 'prop', side: 'over', value: line };
        return { pickType: 'prop', side: 'under', value: line };
      }

      case 'correct-score': {
        // Single prediction column with a score like "1-0"
        return { pickType: 'prop', side: 'home', value: oddsValue };
      }

      case 'ht-ft': {
        // Combined HT/FT result like "1/1" (home/home), "1/X" (home/draw), etc.
        return { pickType: 'prop', side: 'home', value: oddsValue };
      }

      default:
        return null;
    }
  }

  /**
   * Parse kick-off text like "16/02 19:30" into gameDate and gameTime.
   */
  private parseKickOff(
    text: string,
    fetchedAt: Date,
  ): { gameDate: string; gameTime: string | null } {
    const match = text.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:\d{2})/);
    if (!match) {
      return {
        gameDate: fetchedAt.toISOString().split('T')[0]!,
        gameTime: null,
      };
    }

    const day = match[1]!.padStart(2, '0');
    const month = match[2]!.padStart(2, '0');
    const time = match[3]!;
    const year = fetchedAt.getFullYear();

    return {
      gameDate: `${year}-${month}-${day}`,
      gameTime: time,
    };
  }
}
