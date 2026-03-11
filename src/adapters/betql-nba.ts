import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * BetQL NBA adapter.
 *
 * STATUS: NEEDS BROWSER - As of 2026-03-10, fetching via HTTP returns
 * `__NEXT_DATA__` with a `schedule` array (season weeks) and `seoContent`
 * but no game/pick data. The DOM has `.game-row` and `.LiveGameCard`
 * elements but they contain only placeholder divs with `class="placeholder"`.
 * This confirms the page is an SPA that requires full browser rendering
 * for game data to populate.
 *
 * When browser-rendered, the page should use the same structure as BetQL MLB:
 *   - `.LiveGameCard` with `.LiveGameCardRow` divs for team names
 *   - `.GameTime` for date/time, `.BetInfo` for odds
 *   - `.game-row` with `.game-abbrev`, `.game-line-text`, `.game-star-holder`
 *   - `.games-table-column__team-cell` etc. for the desktop table view
 * The fetchMethod is already set to 'browser' but the snapshot was fetched
 * via HTTP (meta.json shows fetchMethod: "http"), indicating the fetch
 * worker may have fallen back to HTTP.
 */
export class BetqlNbaAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'betql-nba',
    name: 'BetQL NBA',
    baseUrl: 'https://betql.co',
    fetchMethod: 'browser',
    paths: {
      nba: '/nba/best-bets',
    },
    cron: '0 0 9,15,21 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for Next.js hydration and bet cards to load
    await page.waitForSelector('.LiveGameCard, .games-table-column__team-cell, .game-row:not(.placeholder)', {
      timeout: 15000,
    }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    // Strategy 1: Parse games-table (desktop table view, same as BetQL MLB)
    const $teamCells = $('.games-table-column__team-cell');
    const $lineCells = $('.games-table-column__current-line-cell');

    if ($teamCells.length > 0) {
      $teamCells.each((i, el) => {
        const $cell = $(el);
        const teamNames = $cell.find('.games-table-column__team-name');
        if (teamNames.length < 2) return;

        const awayTeamRaw = $(teamNames[0]).text().trim();
        const homeTeamRaw = $(teamNames[1]).text().trim();
        if (!awayTeamRaw || !homeTeamRaw) return;

        const dateText = $cell.find('.games-table-column__team-date-cell').text().trim();
        if (dateText.toLowerCase().includes('final')) return;

        const timeMatch = dateText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
        const gameTime = timeMatch ? timeMatch[1]! : null;

        const awayBold = $(teamNames[0]).hasClass('games-table-column__team-name--bold');
        const homeBold = $(teamNames[1]).hasClass('games-table-column__team-name--bold');

        let awayOdds: number | null = null;
        let homeOdds: number | null = null;
        if (i < $lineCells.length) {
          const $lineCell = $($lineCells[i]);
          const lineTexts = $lineCell.find('.games-table-column__line-text, .games-table-column__line-text--bold');
          if (lineTexts.length >= 2) {
            awayOdds = this.parseMoneylineValue($(lineTexts[0]).text().trim());
            homeOdds = this.parseMoneylineValue($(lineTexts[1]).text().trim());
          }
        }

        let side: Side = 'home';
        if (awayBold) side = 'away';
        else if (homeBold) side = 'home';
        else if (awayOdds !== null && homeOdds !== null) {
          side = awayOdds < homeOdds ? 'away' : 'home';
        }

        const favOdds = side === 'away' ? awayOdds : homeOdds;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: todayStr,
          gameTime,
          pickType: 'moneyline',
          side,
          value: favOdds,
          pickerName: 'BetQL Model',
          confidence: null,
          reasoning: awayOdds !== null && homeOdds !== null
            ? `ML: ${awayTeamRaw} ${awayOdds > 0 ? '+' : ''}${awayOdds}, ${homeTeamRaw} ${homeOdds! > 0 ? '+' : ''}${homeOdds}`
            : null,
          fetchedAt,
        });
      });

      if (predictions.length > 0) return predictions;
    }

    // Strategy 2: Parse LiveGameCard carousel (same as BetQL MLB)
    $('.LiveGameCard').each((_i, el) => {
      const $card = $(el);
      const $rows = $card.find('.LiveGameCardRow');
      if ($rows.length < 1) return;

      const $nameRow = $($rows[0]);
      const nameDivs = $nameRow.children('div');
      if (nameDivs.length < 2) return;

      const awayTeamRaw = $(nameDivs[0]).text().trim();
      const homeTeamRaw = $(nameDivs[1]).text().trim();
      if (!awayTeamRaw || !homeTeamRaw) return;

      const gameTimeText = $card.find('.GameTime').text().trim();
      const timeMatch = gameTimeText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
      const gameTime = timeMatch ? timeMatch[1]! : null;

      const betInfo = $card.find('.BetInfo').text().trim();
      const mlMatch = betInfo.match(/([A-Z]{2,4})\s*([+-]\d+)/);
      const ouMatch = betInfo.match(/O\/U\s*([\d.]+)/);

      if (mlMatch) {
        const abbrev = mlMatch[1]!;
        const odds = parseInt(mlMatch[2]!, 10);
        const side: Side = awayTeamRaw.toUpperCase().includes(abbrev) ? 'away' : 'home';

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: todayStr,
          gameTime,
          pickType: 'moneyline',
          side,
          value: odds,
          pickerName: 'BetQL Model',
          confidence: null,
          reasoning: betInfo || null,
          fetchedAt,
        });
      }

      if (ouMatch) {
        const total = parseFloat(ouMatch[1]!);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: todayStr,
          gameTime,
          pickType: 'over_under',
          side: 'over',
          value: total,
          pickerName: 'BetQL Model',
          confidence: null,
          reasoning: betInfo || null,
          fetchedAt,
        });
      }
    });

    // Strategy 3: Parse game-row elements (only if they have actual content)
    if (predictions.length === 0) {
      $('.game-row').each((_i, el) => {
        const $row = $(el);
        const abbrev = $row.find('.game-abbrev').text().trim();
        if (!abbrev || $row.find('.placeholder').length > 0) return;

        const lineText = $row.find('.game-line-text').text().trim();
        const starText = $row.find('.game-star-holder').text().trim();

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: abbrev,
          awayTeamRaw: '',
          gameDate: todayStr,
          gameTime: null,
          pickType: 'moneyline',
          side: 'home',
          value: this.parseMoneylineValue(lineText),
          pickerName: 'BetQL Model',
          confidence: null,
          reasoning: starText || null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

}
