import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Tips180 adapter (formerly TipsScore).
 *
 * Scrapes football predictions from tips180.com.
 * This is a React SPA that requires JavaScript to render content.
 * The page shows "You need to enable JavaScript to run this app." without JS.
 *
 * Uses fetchMethod: 'browser' to render the React app via Playwright.
 * After rendering, predictions appear in match cards/rows with:
 *   - Home and away team names
 *   - Prediction tip (1X2, Over/Under, BTTS)
 *   - Odds values
 *   - League/competition info
 *   - Kick-off time
 *
 * Common React-rendered class patterns:
 *   Card: .match-card, .prediction-card, .game-item, [class*="match"], [class*="prediction"]
 *   Teams: [class*="team"], [class*="home"], [class*="away"]
 *   Tips: [class*="tip"], [class*="prediction"], [class*="pick"]
 */
export class TipsScoreAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'tips180',
    name: 'Tips180',
    baseUrl: 'https://www.tips180.com',
    fetchMethod: 'browser',
    paths: {
      football: '/',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  async browserActions(page: Page): Promise<void> {
    // Wait for the React app to render match content
    // Try multiple selectors since we don't know the exact React component class names
    try {
      await page.waitForSelector(
        'table tbody tr, .match-card, .prediction-card, .game-item, [class*="match-row"], [class*="prediction"], [class*="fixture"]',
        { timeout: 15000 },
      );
    } catch {
      // If no specific selector found, wait for any substantial content
      await page.waitForTimeout(5000);
    }

    // Scroll to load any lazy-loaded content
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);

    // Scroll back to top
    await page.evaluate('window.scrollTo(0, 0)');
    await page.waitForTimeout(1000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Strategy 1: Card-based layout (common in React SPAs)
    const cardSelectors = [
      '.match-card', '.prediction-card', '.game-card', '.tip-card',
      '.match-item', '.prediction-item', '.game-item', '.fixture-card',
      '[class*="MatchCard"]', '[class*="PredictionCard"]', '[class*="GameCard"]',
      '[class*="match-card"]', '[class*="prediction-card"]',
      '.event-card', '.match-row', '.prediction-row',
    ];

    for (const cardSel of cardSelectors) {
      if ($(cardSel).length === 0) continue;

      $(cardSel).each((_i, el) => {
        const $card = $(el);

        const homeTeamRaw = this.extractText($card, [
          '.home-team', '.home', '.team-home', '.team-a',
          '[class*="home"]', '[class*="team1"]', '[class*="teamHome"]',
          '.team:first-child', 'span.home',
        ]);
        const awayTeamRaw = this.extractText($card, [
          '.away-team', '.away', '.team-away', '.team-b',
          '[class*="away"]', '[class*="team2"]', '[class*="teamAway"]',
          '.team:last-child', 'span.away',
        ]);
        if (!homeTeamRaw || !awayTeamRaw) return;

        const league = this.extractText($card, [
          '.league', '.league-name', '.competition', '.tournament',
          '[class*="league"]', '[class*="competition"]', '[class*="tournament"]',
        ]);

        const timeText = this.extractText($card, [
          '.time', '.date', '.kick-off', '.kickoff',
          '.match-time', '.match-date',
          '[class*="time"]', '[class*="date"]', '[class*="kickoff"]',
        ]);
        const { gameDate, gameTime } = this.parseDateTime(timeText, fetchedAt);

        const tipText = this.extractText($card, [
          '.tip', '.prediction', '.pick', '.market',
          '.bet-tip', '.prediction-value', '.recommended',
          '[class*="tip"]', '[class*="prediction"]', '[class*="pick"]',
        ]);

        if (!tipText) return;

        const oddsText = this.extractText($card, [
          '.odds', '.odd', '.price', '.odds-value',
          '[class*="odds"]', '[class*="price"]',
        ]);
        const odds = parseFloat(oddsText) || null;

        const probText = this.extractText($card, [
          '.probability', '.chance', '.confidence', '.percentage',
          '[class*="probability"]', '[class*="confidence"]', '[class*="percent"]',
        ]);

        const { pickType, side, value } = this.parseTip(tipText);
        const confidence = this.parseProbability(probText) ??
          (odds ? this.oddsToConfidence(odds) : null);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType,
          side,
          value,
          pickerName: 'Tips180',
          confidence,
          reasoning: league || null,
          fetchedAt,
        });
      });

      if (predictions.length > 0) return predictions;
    }

    // Strategy 2: Table-based layout
    let currentLeague = '';

    $('table').each((_i, tableEl) => {
      const $table = $(tableEl);

      $table.find('thead').each((_j, theadEl) => {
        const leagueText = $(theadEl).text().trim();
        if (leagueText && leagueText.length > 2) currentLeague = leagueText;
      });

      $table.find('tbody tr').each((_j, rowEl) => {
        const $row = $(rowEl);

        // Skip header rows
        if ($row.find('th').length > 0) return;

        // League separator
        const colspanCell = $row.find('td[colspan]');
        if (colspanCell.length > 0) {
          const text = colspanCell.text().trim();
          if (text.length > 2) currentLeague = text;
          return;
        }

        const cells = $row.find('td');
        if (cells.length < 3) return;

        let homeTeamRaw = '';
        let awayTeamRaw = '';
        let tipText = '';
        let oddsText = '';
        let timeText = '';

        // Try combined teams in a cell
        for (let c = 0; c < Math.min(cells.length, 4); c++) {
          const cellText = $(cells[c]).text().trim();
          const sepMatch = cellText.match(/^(.+?)\s+(?:vs?\.?|[-–])\s+(.+)$/i);
          if (sepMatch && sepMatch[1] && sepMatch[2]) {
            homeTeamRaw = sepMatch[1].trim();
            awayTeamRaw = sepMatch[2].trim();
            break;
          }
        }

        if (!homeTeamRaw || !awayTeamRaw) {
          if (cells.length >= 6) {
            timeText = $(cells[0]).text().trim();
            currentLeague = $(cells[1]).text().trim() || currentLeague;
            homeTeamRaw = $(cells[2]).text().trim();
            awayTeamRaw = $(cells[3]).text().trim();
            tipText = $(cells[4]).text().trim();
            oddsText = $(cells[5]).text().trim();
          } else if (cells.length >= 5) {
            homeTeamRaw = $(cells[0]).text().trim();
            awayTeamRaw = $(cells[1]).text().trim();
            tipText = $(cells[2]).text().trim();
            oddsText = $(cells[3]).text().trim();
            timeText = $(cells[4]).text().trim();
          } else if (cells.length >= 4) {
            homeTeamRaw = $(cells[0]).text().trim();
            awayTeamRaw = $(cells[1]).text().trim();
            tipText = $(cells[2]).text().trim();
            oddsText = $(cells[3]).text().trim();
          } else {
            homeTeamRaw = $(cells[0]).text().trim();
            awayTeamRaw = $(cells[1]).text().trim();
            tipText = $(cells[2]).text().trim();
          }
        }

        if (!homeTeamRaw || !awayTeamRaw) return;

        if (!tipText) {
          tipText = this.extractText($row, [
            'td.tip', 'td.prediction', 'td.pick', 'td.market',
          ]);
        }
        if (!tipText) return;

        const { gameDate, gameTime } = this.parseDateTime(timeText, fetchedAt);
        const { pickType, side, value } = this.parseTip(tipText);
        const odds = parseFloat(oddsText) || null;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw,
          awayTeamRaw,
          gameDate,
          gameTime,
          pickType,
          side,
          value,
          pickerName: 'Tips180',
          confidence: odds ? this.oddsToConfidence(odds) : null,
          reasoning: currentLeague || null,
          fetchedAt,
        });
      });
    });

    // Strategy 3: Generic div-based layout (React often uses divs)
    if (predictions.length === 0) {
      // Look for any element that contains "vs" or "v" text pattern
      $('div, article, section, li').each((_i, el) => {
        const $el = $(el);
        // Only process leaf-ish containers (not deeply nested)
        if ($el.children().length > 20) return;

        const text = $el.text().trim();
        if (text.length > 500) return; // Too much text, probably a parent container

        const vsMatch = text.match(/^(.+?)\s+(?:vs?\.?)\s+(.+?)$/im);
        if (!vsMatch || !vsMatch[1] || !vsMatch[2]) return;

        // Check if this element has team-like children
        const homeTeam = vsMatch[1].trim();
        const awayTeam = vsMatch[2].trim();

        // Skip if team names are too long (likely not team names)
        if (homeTeam.length > 50 || awayTeam.length > 50) return;
        if (homeTeam.length < 2 || awayTeam.length < 2) return;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate: today,
          gameTime: null,
          pickType: 'moneyline',
          side: 'home',
          value: null,
          pickerName: 'Tips180',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private extractText(
    $el: ReturnType<ReturnType<typeof this.load>>,
    selectors: string[],
  ): string {
    for (const sel of selectors) {
      const text = $el.find(sel).first().text().trim();
      if (text) return text;
    }
    return '';
  }

  private parseTip(tip: string): {
    pickType: RawPrediction['pickType'];
    side: Side;
    value: number | null;
  } {
    const lower = tip.toLowerCase().trim();

    // Over/Under with value
    const ouMatch = lower.match(/^(over|under)\s*([\d.]+)/);
    if (ouMatch) {
      return {
        pickType: 'over_under',
        side: ouMatch[1] as Side,
        value: parseFloat(ouMatch[2]!),
      };
    }

    // Shorthand O/U: "o2.5", "u2.5"
    const shortOu = lower.match(/^(o|u)\s*([\d.]+)/);
    if (shortOu) {
      return {
        pickType: 'over_under',
        side: shortOu[1] === 'o' ? 'over' : 'under',
        value: parseFloat(shortOu[2]!),
      };
    }

    // BTTS
    if (lower === 'gg' || lower === 'btts' || lower === 'btts yes' || lower === 'btts - yes') {
      return { pickType: 'prop', side: 'yes', value: null };
    }
    if (lower === 'ng' || lower === 'btts no' || lower === 'btts - no') {
      return { pickType: 'prop', side: 'no', value: null };
    }

    // 1X2
    const side = this.tipToSide(lower);
    return { pickType: 'moneyline', side, value: null };
  }

  private tipToSide(tip: string): Side {
    switch (tip) {
      case '1': case 'h': case 'home': case 'home win': case '1x': return 'home';
      case '2': case 'a': case 'away': case 'away win': case 'x2': return 'away';
      case 'x': case 'd': case 'draw': return 'draw';
      default: return 'home';
    }
  }

  private parseProbability(text: string): Confidence | null {
    if (!text) return null;
    const match = text.match(/([\d.]+)/);
    if (!match) return null;
    const prob = parseFloat(match[1]!);
    if (isNaN(prob)) return null;
    if (prob >= 75) return 'best_bet';
    if (prob >= 60) return 'high';
    if (prob >= 45) return 'medium';
    return 'low';
  }

  private oddsToConfidence(odds: number): Confidence | null {
    if (odds <= 0) return null;
    const impliedProb = 1 / odds;
    if (impliedProb >= 0.75) return 'best_bet';
    if (impliedProb >= 0.55) return 'high';
    if (impliedProb >= 0.35) return 'medium';
    return 'low';
  }

  private parseDateTime(
    text: string,
    fetchedAt: Date,
  ): { gameDate: string; gameTime: string | null } {
    if (!text) {
      return { gameDate: fetchedAt.toISOString().split('T')[0]!, gameTime: null };
    }

    const full = text.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s+(\d{1,2}:\d{2})/);
    if (full) {
      const day = full[1]!.padStart(2, '0');
      const month = full[2]!.padStart(2, '0');
      return { gameDate: `${full[3]}-${month}-${day}`, gameTime: full[4]! };
    }

    const dateOnly = text.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
    if (dateOnly) {
      const day = dateOnly[1]!.padStart(2, '0');
      const month = dateOnly[2]!.padStart(2, '0');
      return { gameDate: `${dateOnly[3]}-${month}-${day}`, gameTime: null };
    }

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) {
      return { gameDate: text.trim(), gameTime: null };
    }

    const timeOnly = text.match(/(\d{1,2}:\d{2})/);
    return {
      gameDate: fetchedAt.toISOString().split('T')[0]!,
      gameTime: timeOnly ? timeOnly[1]! : null,
    };
  }
}
