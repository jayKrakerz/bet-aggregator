import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * NBA Analysis adapter.
 *
 * STATUS: URL returns 404 "Page not found". The prediction path
 * may have changed on nbaanalysis.net. Check for updated URL.
 *
 * NBAAnalysis.net publishes daily NBA predictions articles with
 * game-by-game breakdowns including spread and total picks.
 *
 * Page structure (article-based predictions):
 * - `.entry-content, .post-content`: article body
 * - `h2, h3`: game matchup headers ("Team A vs Team B")
 * - `strong, b`: pick callouts ("Pick: Lakers -3.5")
 * - `.prediction-block`: structured prediction blocks (if available)
 * - `.game-prediction`: individual game prediction container
 */
export class NbaAnalysisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'nba-analysis',
    name: 'NBA Analysis',
    baseUrl: 'https://www.nbaanalysis.net',
    fetchMethod: 'http',
    paths: {
      nba: '/nba-predictions-today/',
    },
    cron: '0 0 10,16 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const todayStr = fetchedAt.toISOString().split('T')[0]!;

    // Try structured prediction blocks first
    $('.game-prediction, .prediction-block, .pick-card').each((_i, el) => {
      const $block = $(el);
      const matchupText = $block.find('h2, h3, .matchup-title').first().text().trim();
      const teams = this.parseMatchupText(matchupText);
      if (!teams) return;

      const pickText = $block.find('.pick, .prediction, strong').text().trim();
      const side = this.resolveSide(pickText, teams.away, teams.home);
      const pickType = this.inferPickType(pickText);
      const value = pickType === 'spread' ? this.parseSpreadValue(pickText)
        : pickType === 'over_under' ? this.parseTotalValue(pickText)
        : null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: teams.home,
        awayTeamRaw: teams.away,
        gameDate: todayStr,
        gameTime: null,
        pickType,
        side,
        value,
        pickerName: 'NBA Analysis',
        confidence: null,
        reasoning: pickText.slice(0, 300) || null,
        fetchedAt,
      });
    });

    // Fallback: parse article body for matchup headers and picks
    if (predictions.length === 0) {
      const content = $('.entry-content, .post-content, article').first();
      const headings = content.find('h2, h3');

      headings.each((_i, el) => {
        const headingText = $(el).text().trim();
        const teams = this.parseMatchupText(headingText);
        if (!teams) return;

        // Look for the pick in the following paragraphs until the next heading
        let pickText = '';
        let nextEl = $(el).next();
        for (let j = 0; j < 10 && nextEl.length; j++) {
          if (nextEl.is('h2, h3')) break;
          const text = nextEl.text().trim();
          const pickMatch = text.match(/pick:\s*(.+?)(?:\.|$)/i)
            || text.match(/prediction:\s*(.+?)(?:\.|$)/i)
            || text.match(/best bet:\s*(.+?)(?:\.|$)/i);
          if (pickMatch) {
            pickText = pickMatch[1]!.trim();
            break;
          }
          nextEl = nextEl.next();
        }

        if (!pickText) return;

        const side = this.resolveSide(pickText, teams.away, teams.home);
        const pickType = this.inferPickType(pickText);
        const value = pickType === 'spread' ? this.parseSpreadValue(pickText)
          : pickType === 'over_under' ? this.parseTotalValue(pickText)
          : null;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: teams.home,
          awayTeamRaw: teams.away,
          gameDate: todayStr,
          gameTime: null,
          pickType,
          side,
          value,
          pickerName: 'NBA Analysis',
          confidence: null,
          reasoning: pickText.slice(0, 300) || null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  /** Parse "Team A vs Team B" or "Team A at Team B" style text. */
  private parseMatchupText(text: string): { away: string; home: string } | null {
    const match = text.match(/^(.+?)\s+(?:vs\.?|@|at)\s+(.+?)(?:\s*[-–—(]|$)/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
  }

  /** Determine side from pick text and team names. */
  private resolveSide(pickText: string, away: string, home: string): Side {
    const lower = pickText.toLowerCase();
    if (lower.includes('under')) return 'under';
    if (lower.includes('over')) return 'over';

    const awayLast = away.toLowerCase().split(' ').pop()!;
    const homeLast = home.toLowerCase().split(' ').pop()!;

    if (lower.includes(awayLast)) return 'away';
    if (lower.includes(homeLast)) return 'home';
    return 'home';
  }
}
