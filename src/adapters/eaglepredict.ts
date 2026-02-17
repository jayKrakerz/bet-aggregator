import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * EaglePredict adapter.
 *
 * Tailwind/Alpine.js site with two prediction layouts:
 *
 * 1. Featured cards (top 3):
 *    - `div.card.overflow-hidden` with a `div.grid.grid-cols-4` containing team logos/names
 *    - Teams in `<p>` tags next to `<img alt="TeamName logo">`
 *    - Prediction in `.italic` div ("HT/FT - 1/1", "Cagliari Win", "Correct Score: 0-2")
 *    - Odds in `span.font-bold.text-primary`
 *    - Date in `<p>` like "Mon - 16 Feb 2026"
 *
 * 2. Calendar list (bulk):
 *    - `div.grid[data-partner]` rows
 *    - `span.btn-prediction-calendar` — prediction text ("Alajuelense Win")
 *    - `a[href*=predictions/match]` — URL encodes teams, league, date:
 *      /predictions/match/{home}-vs-{away}-prediction-{league}-{DD-MM-YYYY}/
 */
export class EaglePredictAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'eaglepredict',
    name: 'EaglePredict',
    baseUrl: 'https://eaglepredict.com',
    fetchMethod: 'browser',
    paths: { football: '/predictions/straight-win/' },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('span.btn-prediction-calendar, div.grid.grid-cols-4', {
      timeout: 20000,
    }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    predictions.push(...this.parseFeaturedCards(html, sport, fetchedAt));
    predictions.push(...this.parseCalendarList(html, sport, fetchedAt));

    return predictions;
  }

  /**
   * Parse the top featured cards with full match details.
   */
  private parseFeaturedCards(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Featured cards have a grid-cols-4 with V.S text and team images
    $('div.grid.grid-cols-4').each((_i, el) => {
      const $grid = $(el);
      const text = $grid.text();
      if (!text.includes('V.S')) return;

      // Extract team names from img alt attributes
      const teams: string[] = [];
      $grid.find('img').each((_j, img) => {
        const alt = $(img).attr('alt') || '';
        if (alt.endsWith(' logo')) {
          const name = alt.replace(' logo', '').trim();
          if (name.length > 1) teams.push(name);
        }
      });
      if (teams.length < 2) return;

      const homeTeamRaw = teams[0]!;
      const awayTeamRaw = teams[1]!;

      // Find prediction in the next sibling grid (the prediction row)
      const $card = $grid.closest('div.overflow-hidden');
      const predText = $card.find('.italic').first().text().trim();
      if (!predText) return;

      const { pickType, side, value } = this.parsePredictionText(predText, homeTeamRaw, awayTeamRaw);

      // Extract odds
      const oddsSpans = $card.find('span.font-bold');
      let odds: number | null = null;
      oddsSpans.each((_j, span) => {
        const t = $(span).text().trim();
        if (/^\d+\.\d+$/.test(t) && parseFloat(t) > 1) {
          odds = parseFloat(t);
        }
      });

      // Extract date from card
      const dateMatch = $card.text().match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i);
      let gameDate = fetchedAt.toISOString().split('T')[0]!;
      if (dateMatch) {
        const months: Record<string, string> = {
          jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
          jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
        };
        const day = dateMatch[1]!.padStart(2, '0');
        const month = months[dateMatch[2]!.toLowerCase()]!;
        gameDate = `${dateMatch[3]}-${month}-${day}`;
      }

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate,
        gameTime: null,
        pickType,
        side,
        value: odds ?? value,
        pickerName: 'EaglePredict',
        confidence: null,
        reasoning: null,
        fetchedAt,
      });
    });

    return predictions;
  }

  /**
   * Parse the calendar-style prediction list (bulk of predictions).
   */
  private parseCalendarList(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('div.grid[data-partner]').each((_i, el) => {
      const $grid = $(el);
      const predSpan = $grid.find('span.btn-prediction-calendar');
      if (predSpan.length === 0) return;

      const predText = predSpan.text().trim();
      if (!predText) return;

      // Extract teams, league, date from match URL
      const matchLink = $grid.find('a[href*="predictions/match"]');
      const href = matchLink.attr('href') || '';
      const urlMatch = href.match(
        /\/match\/(.+?)-vs-(.+?)-prediction-(.+?)-(\d{2})-(\d{2})-(\d{4})/,
      );
      if (!urlMatch) return; // Skip entries without match links (no opponent info)

      const homeTeamRaw = this.slugToName(urlMatch[1]!);
      const awayTeamRaw = this.slugToName(urlMatch[2]!);
      const league = this.slugToName(urlMatch[3]!);
      const gameDate = `${urlMatch[6]}-${urlMatch[5]}-${urlMatch[4]}`;

      const { pickType, side, value } = this.parsePredictionText(predText, homeTeamRaw, awayTeamRaw);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate,
        gameTime: null,
        pickType,
        side,
        value,
        pickerName: 'EaglePredict',
        confidence: null,
        reasoning: league || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private slugToName(slug: string): string {
    return slug
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  private parsePredictionText(
    text: string,
    home: string,
    away: string,
  ): { pickType: RawPrediction['pickType']; side: Side; value: number | null } {
    const lower = text.toLowerCase().trim();

    // Over/Under
    const ouMatch = lower.match(/(over|under)\s+([\d.]+)/);
    if (ouMatch) {
      return { pickType: 'over_under', side: ouMatch[1] as Side, value: parseFloat(ouMatch[2]!) };
    }

    // BTTS
    if (lower.includes('btts yes') || lower === 'gg' || lower === 'yes') {
      return { pickType: 'prop', side: 'yes', value: null };
    }
    if (lower.includes('btts no') || lower === 'ng' || lower === 'no') {
      return { pickType: 'prop', side: 'no', value: null };
    }

    // Correct Score
    const scoreMatch = lower.match(/correct\s+score[:\s]+([\d]+)\s*-\s*([\d]+)/);
    if (scoreMatch) {
      const homeGoals = parseInt(scoreMatch[1]!, 10);
      const awayGoals = parseInt(scoreMatch[2]!, 10);
      const side: Side = homeGoals > awayGoals ? 'home' : homeGoals < awayGoals ? 'away' : 'draw';
      return { pickType: 'moneyline', side, value: null };
    }

    // HT/FT patterns like "HT/FT - 1/1" or "HT/FT - 2/1"
    const htftMatch = lower.match(/ht\/ft\s*-?\s*([12x])\/([12x])/);
    if (htftMatch) {
      const ft = htftMatch[2]!;
      if (ft === '1') return { pickType: 'moneyline', side: 'home', value: null };
      if (ft === '2') return { pickType: 'moneyline', side: 'away', value: null };
      return { pickType: 'moneyline', side: 'draw', value: null };
    }

    // Explicit codes
    if (lower === '1' || lower === 'home win' || lower === 'home') {
      return { pickType: 'moneyline', side: 'home', value: null };
    }
    if (lower === 'x' || lower === 'draw') {
      return { pickType: 'moneyline', side: 'draw', value: null };
    }
    if (lower === '2' || lower === 'away win' || lower === 'away') {
      return { pickType: 'moneyline', side: 'away', value: null };
    }
    if (lower === '1x') return { pickType: 'moneyline', side: 'home', value: null };
    if (lower === 'x2') return { pickType: 'moneyline', side: 'away', value: null };

    // "TeamName Win" pattern — match against home/away
    const winMatch = lower.match(/^(.+?)\s+win$/);
    if (winMatch) {
      const team = winMatch[1]!.trim();
      const side = this.resolveWinSide(team, home, away);
      return { pickType: 'moneyline', side, value: null };
    }

    return { pickType: 'moneyline', side: 'home', value: null };
  }

  private resolveWinSide(team: string, home: string, away: string): Side {
    const tLower = team.toLowerCase();
    const hLower = home.toLowerCase();
    const aLower = away.toLowerCase();
    if (tLower === hLower || hLower.includes(tLower) || tLower.includes(hLower)) return 'home';
    if (tLower === aLower || aLower.includes(tLower) || tLower.includes(aLower)) return 'away';
    // Partial word match
    const tWords = tLower.split(/\s+/);
    if (tWords.some((w) => w.length > 3 && hLower.includes(w))) return 'home';
    if (tWords.some((w) => w.length > 3 && aLower.includes(w))) return 'away';
    return 'home';
  }
}
