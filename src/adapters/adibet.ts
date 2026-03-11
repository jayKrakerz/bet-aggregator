import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * Adibet adapter.
 *
 * Old-school static HTML tables. Predictions indicated by inline bgcolor/color:
 *   Selected: td bgcolor="#272727" + font color="#D5B438" (gold on dark)
 *   Not selected: td bgcolor="#3E415A" + font color="#000000" (invisible)
 *
 * 8 cells per match row:
 *   0: country flag img (alt = country name)
 *   1: "Home - Away" in font color="#D5B438"
 *   2-7: prediction buttons: 1, X, 2, +1.5, GG, +2.5
 *
 * Date groups: font color="#C0C0C0" > b with "DD - MM - YYYY"
 */
export class AdibetAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'adibet',
    name: 'Adibet',
    baseUrl: 'https://www.adibet.com',
    fetchMethod: 'http',
    paths: {
      football: '/',
    },
    cron: '0 0 6,10,14,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    let currentDate = fetchedAt.toISOString().split('T')[0]!;

    // Find date headers
    $('font[color="#C0C0C0"] b').each((_i, el) => {
      const text = $(el).text().trim();
      const dateMatch = text.match(/(\d{2})\s*-\s*(\d{2})\s*-\s*(\d{4})/);
      if (dateMatch) {
        currentDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
      }
    });

    // Find all match rows: tr with exactly 8 td children in match tables
    $('table[width="620"][bgcolor="#666666"] tr').each((_i, el) => {
      const $row = $(el);
      const cells = $row.find('td');
      if (cells.length !== 8) return;

      // Country from flag alt
      const country = cells.eq(0).find('img').attr('alt')?.trim() || '';

      // Team names: "Home - Away"
      const teamsText = cells.eq(1).find('font[color="#D5B438"]').text().trim().replace(/\s+/g, ' ');
      if (!teamsText.includes(' - ')) return;
      const [home, away] = teamsText.split(' - ').map(t => t.trim());
      if (!home || !away) return;

      // Check which predictions are selected (bgcolor="#272727" + font color="#D5B438")
      const predLabels = ['1', 'X', '2', '+1.5', 'GG', '+2.5'];
      const selected: string[] = [];

      for (let i = 2; i < 8; i++) {
        const cellBg = (cells.eq(i).attr('bgcolor') || '').toLowerCase();
        const fontColor = (cells.eq(i).find('font').attr('color') || '').toLowerCase();
        if (cellBg === '#272727' && fontColor === '#d5b438') {
          selected.push(predLabels[i - 2]!);
        }
      }

      if (selected.length === 0) return;

      // Create predictions for each selected market
      for (const sel of selected) {
        const parsed = this.parsePredLabel(sel);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: currentDate,
          gameTime: null,
          pickType: parsed.pickType,
          side: parsed.side,
          value: parsed.value,
          pickerName: 'Adibet',
          confidence: 'medium',
          reasoning: `${sel}${country ? ` | ${country}` : ''}`,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private parsePredLabel(label: string): {
    pickType: RawPrediction['pickType'];
    side: Side;
    value: number | null;
  } {
    switch (label) {
      case '1': return { pickType: 'moneyline', side: 'home', value: null };
      case 'X': return { pickType: 'moneyline', side: 'draw', value: null };
      case '2': return { pickType: 'moneyline', side: 'away', value: null };
      case '+1.5': return { pickType: 'over_under', side: 'over', value: 1.5 };
      case 'GG': return { pickType: 'prop', side: 'yes', value: null }; // BTTS
      case '+2.5': return { pickType: 'over_under', side: 'over', value: 2.5 };
      default: return { pickType: 'moneyline', side: 'home', value: null };
    }
  }
}
