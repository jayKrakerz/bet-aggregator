import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * BetQL MLB adapter.
 *
 * STATUS: WORKING - Browser-rendered snapshot from 2026-03-10 shows
 * Spring Training games. The page uses two views:
 *   1. LiveGameCard carousel: `.LiveGameCard` with `.LiveGameCardRow` divs
 *      containing team names, `.GameTime` for date/time, `.BetInfo` for odds.
 *   2. games-table: `.games-table-column__team-cell` per game row with
 *      `.games-table-column__team-name` (away first, home second),
 *      `.games-table-column__team-date-cell` for date/time,
 *      `.games-table-column__current-line-cell` with `.games-table-column__line-text`
 *      for moneyline odds (bold = favorite).
 *      `.games-table-column__value-rating-cell` for ratings (paywalled).
 */
export class BetqlMlbAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'betql-mlb',
    name: 'BetQL MLB',
    baseUrl: 'https://betql.co',
    fetchMethod: 'browser',
    paths: {
      mlb: '/mlb/picks',
    },
    cron: '0 0 10,14,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 8000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Try __NEXT_DATA__ first
    const nextData = $('script#__NEXT_DATA__').html();
    if (nextData) {
      try {
        const data = JSON.parse(nextData);
        const picks = this.extractFromNextData(data, sport, today, fetchedAt);
        if (picks.length > 0) return picks;
      } catch { /* fall through */ }
    }

    // Strategy 1: Parse games-table (desktop table view)
    // The table has separate columns; we pair team-cells with line-cells by index.
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

        // Skip finished games
        const dateText = $cell.find('.games-table-column__team-date-cell').text().trim();
        if (dateText.toLowerCase().includes('final')) return;

        // Extract game time from date cell (e.g. "Today, 5:05 PM" or "Today, 5:05 PM on SCHN")
        const timeMatch = dateText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
        const gameTime = timeMatch ? timeMatch[1]! : null;

        // Bold team name = favorite
        const awayBold = $(teamNames[0]).hasClass('games-table-column__team-name--bold');
        const homeBold = $(teamNames[1]).hasClass('games-table-column__team-name--bold');

        // Get moneyline odds from the corresponding line cell
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

        // Determine favorite side based on bold or lower odds
        let side: Side = 'home';
        if (awayBold) side = 'away';
        else if (homeBold) side = 'home';
        else if (awayOdds !== null && homeOdds !== null) {
          // Lower (more negative) odds = favorite
          side = awayOdds < homeOdds ? 'away' : 'home';
        }

        const favOdds = side === 'away' ? awayOdds : homeOdds;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: today,
          gameTime,
          pickType: 'moneyline',
          side,
          value: favOdds,
          pickerName: 'BetQL',
          confidence: null,
          reasoning: awayOdds !== null && homeOdds !== null
            ? `ML: ${awayTeamRaw} ${awayOdds > 0 ? '+' : ''}${awayOdds}, ${homeTeamRaw} ${homeOdds! > 0 ? '+' : ''}${homeOdds}`
            : null,
          fetchedAt,
        });
      });

      if (predictions.length > 0) return predictions;
    }

    // Strategy 2: Parse LiveGameCard carousel (mobile/card view)
    $('.LiveGameCard').each((_i, el) => {
      const $card = $(el);
      // First LiveGameCardRow has team names as direct child divs
      const $rows = $card.find('.LiveGameCardRow');
      if ($rows.length < 1) return;

      const $nameRow = $($rows[0]);
      const nameDivs = $nameRow.children('div');
      if (nameDivs.length < 2) return;

      const awayTeamRaw = $(nameDivs[0]).text().trim();
      const homeTeamRaw = $(nameDivs[1]).text().trim();
      if (!awayTeamRaw || !homeTeamRaw) return;

      // GameTime element
      const gameTimeText = $card.find('.GameTime').text().trim();
      const timeMatch = gameTimeText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
      const gameTime = timeMatch ? timeMatch[1]! : null;

      // BetInfo: e.g. "MIN -115, O/U 8"
      const betInfo = $card.find('.BetInfo').text().trim();
      const mlMatch = betInfo.match(/([A-Z]{2,4})\s*([+-]\d+)/);
      const ouMatch = betInfo.match(/O\/U\s*([\d.]+)/);

      // Moneyline pick from BetInfo
      if (mlMatch) {
        const abbrev = mlMatch[1]!;
        const odds = parseInt(mlMatch[2]!, 10);
        const side: Side = abbrev === awayTeamRaw.slice(0, abbrev.length).toUpperCase()
          || awayTeamRaw.toUpperCase().includes(abbrev)
          ? 'away' : 'home';

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: today,
          gameTime,
          pickType: 'moneyline',
          side,
          value: odds,
          pickerName: 'BetQL',
          confidence: null,
          reasoning: betInfo || null,
          fetchedAt,
        });
      }

      // Over/under from BetInfo
      if (ouMatch) {
        const total = parseFloat(ouMatch[1]!);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate: today,
          gameTime,
          pickType: 'over_under',
          side: 'over',
          value: total,
          pickerName: 'BetQL',
          confidence: null,
          reasoning: betInfo || null,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private gradeToConfidence(grade: string): RawPrediction['confidence'] {
    if (grade.startsWith('A')) return 'best_bet';
    if (grade.startsWith('B')) return 'high';
    if (grade.startsWith('C')) return 'medium';
    if (grade.startsWith('D') || grade.startsWith('F')) return 'low';
    return null;
  }

  private resolveSide(text: string, home: string, away: string): Side {
    const lower = text.toLowerCase();
    if (lower.includes('over')) return 'over';
    if (lower.includes('under')) return 'under';
    const hLower = home.toLowerCase();
    const aLower = away.toLowerCase();
    if (lower.includes(hLower) || hLower.includes(lower)) return 'home';
    if (lower.includes(aLower) || aLower.includes(lower)) return 'away';
    return 'home';
  }

  private extractFromNextData(
    data: any,
    sport: string,
    today: string,
    fetchedAt: Date,
  ): RawPrediction[] {
    const predictions: RawPrediction[] = [];
    try {
      const props = data?.props?.pageProps;
      const games = props?.games || props?.picks || [];
      for (const game of games) {
        const homeTeamRaw = game.homeTeam?.name || game.home || '';
        const awayTeamRaw = game.awayTeam?.name || game.away || '';
        if (!homeTeamRaw || !awayTeamRaw) continue;

        const grade = (game.grade || game.rating || '').toUpperCase();
        const confidence = this.gradeToConfidence(grade);

        if (game.moneylinePick) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw,
            awayTeamRaw,
            gameDate: game.gameDate || today,
            gameTime: game.gameTime || null,
            pickType: 'moneyline',
            side: game.moneylinePick === 'home' ? 'home' : 'away',
            value: game.moneylineOdds ?? null,
            pickerName: 'BetQL',
            confidence,
            reasoning: grade ? `Grade: ${grade}` : null,
            fetchedAt,
          });
        }
      }
    } catch { /* ignore */ }
    return predictions;
  }
}
