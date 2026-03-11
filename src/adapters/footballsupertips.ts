import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Football Super Tips adapter.
 *
 * Server-rendered HTML. Each match in `div.poolList`:
 *   .homedisp                          - home team name
 *   .awaydisp                          - away team name
 *   .datedisp                          - "DD/MM/YY HH:MM"
 *   span.prediresults                  - tip: "1", "X", "2", "1X", "X2"
 *   .percdiv > span.percedivspan       - 3 probabilities (1, X, 2)
 *   span.percedivspan.biggestpercen    - highest probability
 *   span.oddsspan                      - decimal odds
 *
 * Grouped by league: div.group.w-100 > .panel-heading strong.cb-bold
 */
export class FootballSuperTipsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'footballsupertips',
    name: 'Football Super Tips',
    baseUrl: 'https://www.footballsuper.tips',
    fetchMethod: 'http',
    paths: {
      football: '/todays-free-football-super-tips/',
    },
    cron: '0 0 6,10,14,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('div.group.w-100').each((_gi, groupEl) => {
      const $group = $(groupEl);
      const league = $group.find('strong.cb-bold').text().trim();

      $group.find('div.poolList').each((_i, el) => {
        const $match = $(el);

        const home = $match.find('.homedisp').text().trim();
        const away = $match.find('.awaydisp').text().trim();
        if (!home || !away) return;

        // Date: "DD/MM/YY HH:MM"
        const dateText = $match.find('.datedisp').text().trim();
        const gameDate = this.parseDate(dateText);

        // Tip: "1", "X", "2", "1X", "X2"
        const tip = $match.find('span.prediresults').text().trim();
        if (!tip) return;

        // Probabilities (3 spans: home, draw, away)
        const probSpans = $match.find('.percdiv > span.percedivspan');
        const prob1 = parseInt($(probSpans[0]).text(), 10) || 0;
        const probX = parseInt($(probSpans[1]).text(), 10) || 0;
        const prob2 = parseInt($(probSpans[2]).text(), 10) || 0;
        const maxProb = Math.max(prob1, probX, prob2);

        // Odds
        const odds = $match.find('span.oddsspan').text().trim();

        // Confidence
        const confidence: Confidence | null = maxProb >= 60 ? 'high' : maxProb >= 40 ? 'medium' : 'low';

        const side = this.tipToSide(tip);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: gameDate || fetchedAt.toISOString().split('T')[0]!,
          gameTime: dateText || null,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'Football Super Tips',
          confidence,
          reasoning: `Tip: ${tip} | 1:${prob1}% X:${probX}% 2:${prob2}%${odds ? ` | Odds: ${odds}` : ''}${league ? ` | ${league}` : ''}`,
          fetchedAt,
        });
      });
    });

    return predictions;
  }

  private tipToSide(tip: string): Side {
    switch (tip) {
      case '1': return 'home';
      case 'X': return 'draw';
      case '2': return 'away';
      case '1X': return 'home';
      case 'X2': return 'away';
      case '12': return 'home';
      default: return 'home';
    }
  }

  private parseDate(text: string): string | null {
    // "DD/MM/YY HH:MM"
    const match = text.match(/(\d{2})\/(\d{2})\/(\d{2})/);
    if (!match) return null;
    return `20${match[3]}-${match[2]}-${match[1]}`;
  }
}
