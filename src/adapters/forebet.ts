import type { Page } from 'playwright';
import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side, Confidence } from '../types/prediction.js';

/**
 * Forebet adapter.
 *
 * Forebet is a Cloudflare-protected site with server-rendered HTML.
 * Uses Playwright to bypass the challenge, then parses DOM with cheerio.
 *
 * Football 1X2:
 *   - Rows: div.rcnt (alternating tr_0/tr_1)
 *   - Teams: span.homeTeam / span.awayTeam with Schema.org itemprop
 *   - Probabilities: div.fprc with 3 spans (Home%, Draw%, Away%)
 *   - Pick: span.forepr → "1" (home), "X" (draw), "2" (away)
 *   - Odds: div.haodd hidden spans (home, draw, away decimal odds)
 *   - Date: span.date_bah (DD/MM/YYYY HH:MM)
 *
 * Basketball:
 *   - Same structure but div.fprc.bsk has 2 spans (Home%, Away%)
 *   - Score: div.ex_sc → score1<br><b>score2</b>
 *   - Pick: "1" (home) or "2" (away)
 */
export class ForebetAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'forebet',
    name: 'Forebet',
    baseUrl: 'https://www.forebet.com',
    fetchMethod: 'browser',
    paths: {
      football: '/en/football-tips-and-predictions-for-today',
      nba: '/en/basketball/usa/nba',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 5000,
    maxRetries: 2,
    backoff: { type: 'exponential', delay: 10000 },
  };

  async browserActions(page: Page): Promise<void> {
    await page.waitForSelector('div.rcnt', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  discoverUrls(html: string, sport: string): string[] {
    if (sport !== 'football') return [];

    const $ = this.load(html);
    const urls: string[] = [];

    // Discover sub-page URLs from tab navigation
    $('div.tabsCont a').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const text = $(el).text().toLowerCase();

      // Include over/under and BTTS tabs
      if (text.includes('under/over') || text.includes('both to score')) {
        const fullUrl = href.startsWith('http') ? href : `${this.config.baseUrl}${href}`;
        urls.push(fullUrl);
      }
    });

    return urls;
  }

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const isBasketball = sport === 'nba';

    // Detect page type from tab navigation or URL hints
    const pageType = this.detectPageType($, html);

    $('div.rcnt').each((_i, el) => {
      const row = $(el);

      // Extract team names
      let homeTeam: string;
      let awayTeam: string;

      if (isBasketball) {
        homeTeam = row.find('span.homeTeam span').first().text().trim();
        awayTeam = row.find('span.awayTeam span').first().text().trim();
      } else {
        homeTeam =
          row.find('span.homeTeam span[itemprop="name"]').text().trim() ||
          row.find('span.homeTeam span').first().text().trim();
        awayTeam =
          row.find('span.awayTeam span[itemprop="name"]').text().trim() ||
          row.find('span.awayTeam span').first().text().trim();
      }

      if (!homeTeam || !awayTeam) return;

      // Extract date and time
      const dateBah = row.find('span.date_bah').text().trim();
      const { gameDate, gameTime } = this.parseDateTime(dateBah, fetchedAt);

      // Extract probabilities
      const probSpans = row.find('div.fprc span');
      const probs = probSpans.map((_j, s) => parseInt($(s).text().trim(), 10)).get()
        .filter((n) => !isNaN(n));

      // Extract pick
      const pickText = row.find('span.forepr span').text().trim();

      // Extract odds from hidden haodd div
      const oddsSpans = row.find('div.haodd > span');
      const odds = oddsSpans.map((_j, s) => parseFloat($(s).text().trim())).get()
        .filter((n) => !isNaN(n));

      // Extract predicted score
      const exSc = row.find('div.ex_sc');
      const predictedScore = exSc.text().trim().replace(/\s+/g, ' ');

      // Extract average goals/points
      const avgGoals = row.find('div.avg_sc').text().trim();

      // Extract league tag
      const leagueTag = row.find('span.shortTag').text().trim();

      // Build predictions based on page type
      if (pageType === 'over_under') {
        this.parseOverUnder(
          predictions, sport, homeTeam, awayTeam, gameDate, gameTime,
          pickText, probs, odds, leagueTag, predictedScore, avgGoals, fetchedAt,
        );
      } else if (pageType === 'btts') {
        this.parseBtts(
          predictions, sport, homeTeam, awayTeam, gameDate, gameTime,
          pickText, probs, odds, leagueTag, predictedScore, avgGoals, fetchedAt,
        );
      } else {
        // 1X2 / moneyline
        this.parse1X2(
          predictions, sport, homeTeam, awayTeam, gameDate, gameTime,
          pickText, probs, odds, leagueTag, predictedScore, avgGoals,
          isBasketball, fetchedAt,
        );
      }
    });

    return predictions;
  }

  private parse1X2(
    predictions: RawPrediction[],
    sport: string,
    homeTeam: string,
    awayTeam: string,
    gameDate: string,
    gameTime: string | null,
    pickText: string,
    probs: number[],
    odds: number[],
    leagueTag: string,
    predictedScore: string,
    avgGoals: string,
    isBasketball: boolean,
    fetchedAt: Date,
  ): void {
    let side: Side;
    let value: number | null = null;
    let confidence: Confidence | null = null;

    if (isBasketball) {
      // 2-way: probs = [Home%, Away%]
      if (pickText === '1') {
        side = 'home';
        confidence = this.mapProbToConfidence(probs[0]);
        value = odds[0] || null;
      } else if (pickText === '2') {
        side = 'away';
        confidence = this.mapProbToConfidence(probs[1]);
        value = odds[1] || null;
      } else {
        return;
      }
    } else {
      // 3-way: probs = [Home%, Draw%, Away%]
      if (pickText === '1') {
        side = 'home';
        confidence = this.mapProbToConfidence(probs[0]);
        value = odds[0] || null;
      } else if (pickText === 'X') {
        side = 'draw';
        confidence = this.mapProbToConfidence(probs[1]);
        value = odds[1] || null;
      } else if (pickText === '2') {
        side = 'away';
        confidence = this.mapProbToConfidence(probs[2]);
        value = odds[2] || null;
      } else {
        return;
      }
    }

    const parts: string[] = [];
    if (predictedScore) parts.push(`Predicted: ${predictedScore}`);
    if (avgGoals) parts.push(`Avg ${isBasketball ? 'points' : 'goals'}: ${avgGoals}`);
    if (leagueTag) parts.push(leagueTag);

    predictions.push({
      sourceId: this.config.id,
      sport,
      homeTeamRaw: homeTeam,
      awayTeamRaw: awayTeam,
      gameDate,
      gameTime,
      pickType: 'moneyline',
      side,
      value,
      pickerName: 'Forebet',
      confidence,
      reasoning: parts.length > 0 ? parts.join(' | ') : null,
      fetchedAt,
    });
  }

  private parseOverUnder(
    predictions: RawPrediction[],
    sport: string,
    homeTeam: string,
    awayTeam: string,
    gameDate: string,
    gameTime: string | null,
    pickText: string,
    probs: number[],
    odds: number[],
    leagueTag: string,
    predictedScore: string,
    avgGoals: string,
    fetchedAt: Date,
  ): void {
    const lowerPick = pickText.toLowerCase();
    let side: Side;

    if (lowerPick.includes('over') || lowerPick === 'ov') {
      side = 'over';
    } else if (lowerPick.includes('under') || lowerPick === 'un') {
      side = 'under';
    } else {
      return;
    }

    // For O/U, the line is typically 2.5 (encoded in the page header)
    // Use odds[0]=Under odds, odds[1]=Over odds
    const confidence = this.mapProbToConfidence(
      side === 'over' ? probs[1] : probs[0],
    );

    const parts: string[] = [];
    if (predictedScore) parts.push(`Predicted: ${predictedScore}`);
    if (avgGoals) parts.push(`Avg goals: ${avgGoals}`);
    if (leagueTag) parts.push(leagueTag);

    predictions.push({
      sourceId: this.config.id,
      sport,
      homeTeamRaw: homeTeam,
      awayTeamRaw: awayTeam,
      gameDate,
      gameTime,
      pickType: 'over_under',
      side,
      value: 2.5, // Standard line for Forebet O/U page
      pickerName: 'Forebet',
      confidence,
      reasoning: parts.length > 0 ? parts.join(' | ') : null,
      fetchedAt,
    });
  }

  private parseBtts(
    predictions: RawPrediction[],
    sport: string,
    homeTeam: string,
    awayTeam: string,
    gameDate: string,
    gameTime: string | null,
    pickText: string,
    probs: number[],
    _odds: number[],
    leagueTag: string,
    predictedScore: string,
    avgGoals: string,
    fetchedAt: Date,
  ): void {
    const lowerPick = pickText.toLowerCase();
    let side: Side;

    if (lowerPick === 'yes' || lowerPick === 'y') {
      side = 'yes';
    } else if (lowerPick === 'no' || lowerPick === 'n') {
      side = 'no';
    } else {
      return;
    }

    const confidence = this.mapProbToConfidence(
      side === 'yes' ? probs[1] : probs[0],
    );

    const parts: string[] = [];
    if (predictedScore) parts.push(`Predicted: ${predictedScore}`);
    if (avgGoals) parts.push(`Avg goals: ${avgGoals}`);
    if (leagueTag) parts.push(leagueTag);

    predictions.push({
      sourceId: this.config.id,
      sport,
      homeTeamRaw: homeTeam,
      awayTeamRaw: awayTeam,
      gameDate,
      gameTime,
      pickType: 'prop',
      side,
      value: null,
      pickerName: 'Forebet',
      confidence,
      reasoning: parts.length > 0 ? `BTTS | ${parts.join(' | ')}` : 'BTTS',
      fetchedAt,
    });
  }

  private detectPageType(
    $: ReturnType<typeof this.load>,
    _html: string,
  ): 'moneyline' | 'over_under' | 'btts' {
    // Check active tab text (most reliable)
    const activeTab = $('li#current a span, li.current a span').text().toLowerCase();
    if (activeTab.includes('under/over')) return 'over_under';
    if (activeTab.includes('both to score') || activeTab.includes('btts')) return 'btts';

    // Check header table class
    if ($('div.hdrtb.tbuo').length > 0) return 'over_under';

    // Check canonical URL or og:url meta tag (avoids false positives from nav links)
    const canonical = $('link[rel="canonical"]').attr('href') || '';
    const ogUrl = $('meta[property="og:url"]').attr('content') || '';
    const pageUrl = canonical || ogUrl;
    if (pageUrl.includes('under-over') || pageUrl.includes('predictions-uo')) return 'over_under';
    if (pageUrl.includes('both-to-score') || pageUrl.includes('btts')) return 'btts';

    return 'moneyline';
  }

  private parseDateTime(
    dateBah: string,
    fetchedAt: Date,
  ): { gameDate: string; gameTime: string | null } {
    if (!dateBah) {
      return {
        gameDate: fetchedAt.toISOString().split('T')[0]!,
        gameTime: null,
      };
    }

    // Format: "DD/MM/YYYY HH:MM" or "DD.MM.YYYY HH:MM"
    const match = dateBah.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})\s+(\d{1,2}):(\d{2})/);
    if (match) {
      const day = match[1]!.padStart(2, '0');
      const month = match[2]!.padStart(2, '0');
      const year = match[3]!;
      const hour = match[4]!;
      const minute = match[5]!;
      return {
        gameDate: `${year}-${month}-${day}`,
        gameTime: `${hour}:${minute}`,
      };
    }

    // Fallback: just date without time
    const dateOnly = dateBah.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
    if (dateOnly) {
      const day = dateOnly[1]!.padStart(2, '0');
      const month = dateOnly[2]!.padStart(2, '0');
      const year = dateOnly[3]!;
      return {
        gameDate: `${year}-${month}-${day}`,
        gameTime: null,
      };
    }

    return {
      gameDate: fetchedAt.toISOString().split('T')[0]!,
      gameTime: null,
    };
  }

  private mapProbToConfidence(prob: number | undefined): Confidence | null {
    if (!prob || isNaN(prob)) return null;
    if (prob >= 75) return 'best_bet';
    if (prob >= 60) return 'high';
    if (prob >= 45) return 'medium';
    return 'low';
  }
}
