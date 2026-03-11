import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Pivot Analysis adapter.
 *
 * Scrapes NBA prediction data from pivotanalysis.com.
 * Site publishes analytical NBA predictions with ATS, O/U, and ML picks.
 *
 * Expected structure:
 * - `.game-card`, `.prediction-block`, or `table tbody tr` rows
 * - Team names in `.team`, `.team-name`, or adjacent cells
 * - Pick details in `.pick`, `.recommendation`, `.ats-pick`
 * - Spread/total in `.spread`, `.line`, `.total`
 * - Analysis in `.analysis`, `.breakdown`, `.reasoning`
 */
export class PivotAnalysisAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'pivotanalysis',
    name: 'Pivot Analysis',
    baseUrl: 'https://www.pivotanalysis.com',
    fetchMethod: 'http',
    paths: {
      nba: '/nba-predictions/',
    },
    cron: '0 0 11,15,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    $(
      '.game-card, .prediction-block, .pick-card, .matchup-container, ' +
      'table.predictions tbody tr, article.prediction, .game-wrap, .nba-prediction',
    ).each((_i, el) => {
      const $card = $(el);

      // Extract teams
      const matchupText = $card.find(
        '.matchup, .teams, .game-title, h2, h3, .header',
      ).first().text().trim();
      const teams = this.extractTeams($card, matchupText);
      if (!teams) return;

      const { home, away } = teams;

      // Game time
      const gameTime = $card.find('.game-time, .time, .start-time, .tip-off').text().trim() || null;

      // Confidence
      const confText = $card.find(
        '.confidence, .rating, .grade, .strength, .certainty',
      ).text().trim();
      const confidence = this.inferConfidence(confText);

      // Reasoning
      const reasoning = $card.find(
        '.analysis, .breakdown, .reasoning, .write-up, .description, p',
      ).first().text().trim().slice(0, 300) || null;

      // Look for ATS / spread pick
      const spreadPickText = $card.find(
        '.ats-pick, .spread-pick, .pick-spread',
      ).text().trim();
      const spreadLine = $card.find('.spread, .line, .ats-line').text().trim();
      if (spreadPickText || spreadLine) {
        const side = this.resolveSide(spreadPickText || spreadLine, home, away);
        const value = this.parseSpreadValue(spreadLine);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: today,
          gameTime,
          pickType: 'spread',
          side,
          value,
          pickerName: 'Pivot Analysis',
          confidence,
          reasoning,
          fetchedAt,
        });
      }

      // Look for O/U pick
      const ouPickText = $card.find(
        '.ou-pick, .total-pick, .over-under-pick',
      ).text().trim();
      const totalLine = $card.find('.total, .ou-line, .over-under').text().trim();
      if (ouPickText || totalLine) {
        const ouLower = (ouPickText || totalLine).toLowerCase();
        const ouSide: Side = ouLower.includes('under') ? 'under' : 'over';
        const value = this.parseTotalValue(totalLine || ouPickText);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: today,
          gameTime,
          pickType: 'over_under',
          side: ouSide,
          value,
          pickerName: 'Pivot Analysis',
          confidence,
          reasoning,
          fetchedAt,
        });
      }

      // Look for ML pick
      const mlPickText = $card.find(
        '.ml-pick, .moneyline-pick, .pick-ml',
      ).text().trim();
      if (mlPickText) {
        const side = this.resolveSide(mlPickText, home, away);
        const mlValue = this.parseMoneylineValue(mlPickText);
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: today,
          gameTime,
          pickType: 'moneyline',
          side,
          value: mlValue,
          pickerName: 'Pivot Analysis',
          confidence,
          reasoning,
          fetchedAt,
        });
      }

      // Fallback: generic pick if no specific pick types found
      if (!spreadPickText && !spreadLine && !ouPickText && !totalLine && !mlPickText) {
        const genericPick = $card.find('.pick, .recommendation, .winner, strong').first().text().trim();
        if (genericPick) {
          const side = this.resolveSide(genericPick, home, away);
          const cardText = $card.text().toLowerCase();
          const pickType = this.inferPickType(cardText);
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: home,
            awayTeamRaw: away,
            gameDate: today,
            gameTime,
            pickType,
            side,
            value: null,
            pickerName: 'Pivot Analysis',
            confidence,
            reasoning,
            fetchedAt,
          });
        }
      }
    });

    return predictions;
  }

  private extractTeams(
    $card: ReturnType<ReturnType<typeof this.load>>,
    matchupText: string,
  ): { home: string; away: string } | null {
    const vsMatch = matchupText.match(/^(.+?)\s+(?:@|vs\.?|at)\s+(.+?)$/i);
    if (vsMatch) {
      return { away: vsMatch[1]!.trim(), home: vsMatch[2]!.trim() };
    }

    const teamEls = $card.find('.team-name, .team, td.team, .team-label');
    if (teamEls.length >= 2) {
      return {
        away: teamEls.eq(0).text().trim(),
        home: teamEls.eq(1).text().trim(),
      };
    }

    return null;
  }

  private resolveSide(pick: string, home: string, away: string): Side {
    const pLower = pick.toLowerCase();
    if (pLower.includes('over')) return 'over';
    if (pLower.includes('under')) return 'under';
    const hLower = home.toLowerCase();
    const aLower = away.toLowerCase();
    if (pLower.includes(hLower) || hLower.includes(pLower)) return 'home';
    if (pLower.includes(aLower) || aLower.includes(pLower)) return 'away';
    return 'home';
  }
}
