import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * MyBets (Soccer) adapter.
 *
 * Mybets.today provides daily football predictions grouped by league.
 *
 * Page structure (2026):
 * - Predictions inside `div.listgames`
 * - League headers: `div.titlegames > div.leaguename > a`
 * - Match fixtures: `div.event-fixtures` containing:
 *   - `div.timediv > time[datetime]`: kickoff time (ISO datetime attr)
 *   - `div.homediv > span.homeTeam > span.homespan`: home team name
 *   - `div.awaydiv > span.awayTeam > span.awayspan`: away team name
 *   - `div.tipdiv > span`: prediction tip (1/X/2)
 *
 * Pages are organized by date (today's predictions at root path).
 */
export class MybetsSoccerAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'mybets-soccer',
    name: 'MyBets Today',
    baseUrl: 'https://mybets.today',
    fetchMethod: 'http',
    paths: {
      football: '/soccer-predictions/',
    },
    cron: '0 0 6,12,18 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentLeague = '';

    // Current site structure (2026):
    // League headers: div.titlegames > div.leaguename > a (league name)
    // Match rows: div.event-fixtures containing:
    //   - a.linkgames wrapping the match
    //   - div.timediv > time (kickoff time with datetime attr)
    //   - div.homediv > span.homeTeam > span.homespan (home team name)
    //   - div.awaydiv > span.awayTeam > span.awayspan (away team name)
    //   - div.tipdiv > span (prediction: 1/X/2)
    const $listGames = $('.listgames');

    // Iterate over all children to track league headers and match fixtures
    $listGames.children().each((_i, el) => {
      const $el = $(el);

      // League header
      if ($el.hasClass('titlegames')) {
        currentLeague = $el.find('.leaguename a').text().trim() || $el.find('.leaguename').text().trim();
        return;
      }

      // Match fixture
      if ($el.hasClass('event-fixtures')) {
        const homeTeam = $el.find('.homespan').text().trim();
        const awayTeam = $el.find('.awayspan').text().trim();
        if (!homeTeam || !awayTeam) return;

        const tipText = $el.find('.tipdiv span').text().trim();
        const { side, pickType } = this.parseTip(tipText);
        if (!side) return;

        // Extract time from <time> element
        const timeEl = $el.find('.timediv time');
        const timeText = timeEl.text().trim();
        const dateTimeAttr = timeEl.attr('datetime') || '';

        // Extract game date from datetime attribute (ISO format) or fallback to fetchedAt
        let gameDate = fetchedAt.toISOString().split('T')[0]!;
        const isoMatch = dateTimeAttr.match(/^(\d{4}-\d{2}-\d{2})/);
        if (isoMatch) {
          gameDate = isoMatch[1]!;
        }

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate,
          gameTime: /\d{1,2}:\d{2}/.test(timeText) ? timeText : null,
          pickType,
          side,
          value: pickType === 'over_under' ? this.extractTotal(tipText) : null,
          pickerName: 'MyBets Today',
          confidence: null,
          reasoning: currentLeague || null,
          fetchedAt,
        });
      }
    });

    // Fallback: if listgames container not found, try event-fixtures directly
    if (predictions.length === 0) {
      $('.event-fixtures').each((_i, el) => {
        const $el = $(el);
        const homeTeam = $el.find('.homespan').text().trim();
        const awayTeam = $el.find('.awayspan').text().trim();
        if (!homeTeam || !awayTeam) return;

        const tipText = $el.find('.tipdiv span').text().trim();
        const { side, pickType } = this.parseTip(tipText);
        if (!side) return;

        const timeEl = $el.find('.timediv time');
        const timeText = timeEl.text().trim();

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate: fetchedAt.toISOString().split('T')[0]!,
          gameTime: /\d{1,2}:\d{2}/.test(timeText) ? timeText : null,
          pickType,
          side,
          value: pickType === 'over_under' ? this.extractTotal(tipText) : null,
          pickerName: 'MyBets Today',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private parseTip(text: string): { side: Side | null; pickType: 'moneyline' | 'over_under' } {
    const t = text.toUpperCase().trim();
    if (t.includes('OVER')) return { side: 'over', pickType: 'over_under' };
    if (t.includes('UNDER')) return { side: 'under', pickType: 'over_under' };
    if (t === '1' || t === 'HOME') return { side: 'home', pickType: 'moneyline' };
    if (t === '2' || t === 'AWAY') return { side: 'away', pickType: 'moneyline' };
    if (t === 'X' || t === 'DRAW') return { side: 'draw', pickType: 'moneyline' };
    if (t === '1X') return { side: 'home', pickType: 'moneyline' };
    if (t === 'X2') return { side: 'away', pickType: 'moneyline' };
    return { side: null, pickType: 'moneyline' };
  }

  private extractTotal(text: string): number | null {
    const match = text.match(/([\d.]+)/);
    return match ? parseFloat(match[1]!) : 2.5;
  }

}
