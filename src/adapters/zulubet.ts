import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * ZuluBet adapter.
 *
 * Server-rendered HTML table. table.content_table rows with 14 cells:
 *   cell 0: date/time via mf_usertime('MM/DD/YYYY, HH:mm') script
 *   cell 1: img.flags[title] (league name) + "Home - Away" text
 *   cell 3-5: 1X2 probabilities (td.prob.prediction_full) e.g. "40%"
 *   cell 6: recommended tip in <b> ("1", "X", "2", "1X", "X2", "12")
 *   cell 7: confidence rating
 *   cell 9-11: average odds (td.aver_odds_full)
 *
 * Probability bg colors indicate strength: #00cc00 > #00ff00 > #65ff65 > #ccfecc > AliceBlue
 */
export class ZuluBetAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'zulubet',
    name: 'ZuluBet',
    baseUrl: 'https://www.zulubet.com',
    fetchMethod: 'http',
    paths: {
      football: '/tips-today.html',
    },
    cron: '0 0 6,10,14,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('table.content_table tr').each((i, el) => {
      // Skip header rows
      if (i < 2) return;
      const $row = $(el);

      // Skip spacer rows
      if ($row.hasClass('prediction_min')) return;

      const cells = $row.find('> td');
      if (cells.length < 12) return;

      // League from flag title
      const league = cells.eq(1).find('img.flags').attr('title')?.trim() || '';

      // Teams: text content of cell 1 (after the img)
      const teamsText = cells.eq(1).text().trim().replace(/\s+/g, ' ');
      if (!teamsText.includes(' - ')) return;
      const parts = teamsText.split(' - ');
      if (parts.length < 2) return;
      const home = parts[0]!.trim();
      const away = parts.slice(1).join(' - ').trim();
      if (!home || !away) return;

      // Date/time from script: mf_usertime('MM/DD/YYYY, HH:mm')
      const scriptText = cells.eq(0).find('script').html() || '';
      const timeMatch = scriptText.match(/mf_usertime\('([^']+)'/);
      let gameDate = fetchedAt.toISOString().split('T')[0]!;
      let gameTime: string | null = null;
      if (timeMatch) {
        const dtMatch = timeMatch[1]!.match(/(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{2}:\d{2})/);
        if (dtMatch) {
          gameDate = `${dtMatch[3]}-${dtMatch[1]}-${dtMatch[2]}`;
          gameTime = dtMatch[4]!;
        }
      }

      // Recommended tip
      const tip = cells.eq(6).find('b').text().trim();
      if (!tip) return; // no recommendation

      // 1X2 probabilities
      const prob1 = parseInt(cells.eq(3).text().trim(), 10) || 0;
      const probX = parseInt(cells.eq(4).text().trim(), 10) || 0;
      const prob2 = parseInt(cells.eq(5).text().trim(), 10) || 0;
      const maxProb = Math.max(prob1, probX, prob2);

      // Confidence from probability strength
      const confidence: Confidence | null = maxProb >= 60 ? 'high' : maxProb >= 40 ? 'medium' : 'low';

      // Map tip to side(s)
      const sides = this.tipToSides(tip);

      for (const side of sides) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate,
          gameTime,
          pickType: 'moneyline',
          side,
          value: null,
          pickerName: 'ZuluBet',
          confidence,
          reasoning: `Tip: ${tip} | 1:${prob1}% X:${probX}% 2:${prob2}%${league ? ` | ${league}` : ''}`,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private tipToSides(tip: string): Side[] {
    switch (tip) {
      case '1': return ['home'];
      case 'X': return ['draw'];
      case '2': return ['away'];
      case '1X': return ['home']; // double chance home/draw, favor home
      case 'X2': return ['away']; // double chance draw/away, favor away
      case '12': return ['home']; // both teams can win (no draw), favor home
      default: return ['home'];
    }
  }
}
