import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * FootballTipster adapter.
 *
 * STATUS: UNFIXABLE - /free-tips/ does not exist on the site. The homepage
 * (footballtipster.net/) shows a tipster leaderboard table with stats
 * (tipster name, # tips, hit rate, profit, ROI, W/P/L counts) but no
 * actual match predictions. The site is a tipster marketplace, not a free
 * tips provider. Individual tipster profiles may have predictions but
 * require authentication. This adapter cannot produce predictions.
 */
export class FootballtipsterAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'footballtipster',
    name: 'Football Tipster',
    baseUrl: 'https://www.footballtipster.net',
    fetchMethod: 'http',
    paths: {
      football: '/free-tips/',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Detect homepage leaderboard (no actual predictions) or error pages
    const title = $('title').text().toLowerCase();
    if (title.includes('not found') || title.includes('404')) {
      return predictions;
    }
    // The homepage shows a tipster leaderboard table, not match predictions
    if ($('table.nwupcmTbl').length > 0 || $('h1.banrMainTxt').length > 0) {
      return predictions;
    }

    // Card/item layout
    $('.tip-card, .tip-item, .tips-list > li, .tip-row').each((_i, el) => {
      const $el = $(el);

      const matchText = $el.find('.match, .match-info, .event').text().trim();
      const teams = this.parseTeams(matchText);
      if (!teams) return;

      const pickText = $el.find('.tip-pick, .pick, .selection, .tip').text().trim();
      const { side, pickType } = this.parsePick(pickText);
      if (!side) return;

      const tipster = $el.find('.tipster, .author, .tipster-name').text().trim();
      const league = $el.find('.league, .competition').text().trim();
      const dateText = $el.find('.date, .match-date').text().trim();
      const oddsText = $el.find('.odds, .odd-value').text().trim();
      const odds = parseFloat(oddsText);

      const stars = $el.find('.star.active, .stars .filled, i.fa-star').length;
      const confidence = stars > 0 ? this.starsToConfidence(stars) : this.oddsToConfidence(odds);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: teams.home,
        awayTeamRaw: teams.away,
        gameDate: this.extractDate(dateText, fetchedAt),
        gameTime: null,
        pickType,
        side,
        value: pickType === 'over_under' ? this.extractTotal(pickText) : null,
        pickerName: tipster || 'Football Tipster',
        confidence,
        reasoning: [league, !isNaN(odds) ? `Odds: ${odds}` : ''].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    // Fallback: table layout
    if (predictions.length === 0) {
      $('table.tips-table tbody tr, table tbody tr').each((_i, el) => {
        const cells = $(el).find('td');
        if (cells.length < 4) return;

        const matchText = $(cells[0]).text().trim() || $(cells[1]).text().trim();
        const teams = this.parseTeams(matchText);
        if (!teams) return;

        const pickText = $(cells[2]).text().trim() || $(cells[3]).text().trim();
        const { side, pickType } = this.parsePick(pickText);
        if (!side) return;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: teams.home,
          awayTeamRaw: teams.away,
          gameDate: fetchedAt.toISOString().split('T')[0]!,
          gameTime: null,
          pickType,
          side,
          value: pickType === 'over_under' ? this.extractTotal(pickText) : null,
          pickerName: 'Football Tipster',
          confidence: null,
          reasoning: null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private parseTeams(text: string): { home: string; away: string } | null {
    let parts = text.split(/\s+vs\.?\s+/i);
    if (parts.length < 2) parts = text.split(/\s+v\s+/i);
    if (parts.length < 2) parts = text.split(/\s+-\s+/);
    if (parts.length < 2) return null;
    const home = parts[0]!.trim();
    const away = parts.slice(1).join('-').trim();
    return home && away ? { home, away } : null;
  }

  private parsePick(text: string): { side: Side | null; pickType: 'moneyline' | 'over_under' } {
    const t = text.toUpperCase().trim();
    if (t.includes('OVER')) return { side: 'over', pickType: 'over_under' };
    if (t.includes('UNDER')) return { side: 'under', pickType: 'over_under' };
    if (t === '1' || t.includes('HOME WIN') || t === 'HOME') return { side: 'home', pickType: 'moneyline' };
    if (t === '2' || t.includes('AWAY WIN') || t === 'AWAY') return { side: 'away', pickType: 'moneyline' };
    if (t === 'X' || t.includes('DRAW') || t === 'D') return { side: 'draw', pickType: 'moneyline' };
    if (t === '1X' || t.includes('HOME OR DRAW')) return { side: 'home', pickType: 'moneyline' };
    if (t === 'X2' || t.includes('AWAY OR DRAW')) return { side: 'away', pickType: 'moneyline' };
    return { side: null, pickType: 'moneyline' };
  }

  private extractTotal(text: string): number | null {
    const match = text.match(/([\d.]+)/);
    return match ? parseFloat(match[1]!) : 2.5;
  }

  private starsToConfidence(stars: number): Confidence {
    if (stars >= 5) return 'best_bet';
    if (stars >= 4) return 'high';
    if (stars >= 3) return 'medium';
    return 'low';
  }

  private oddsToConfidence(odds: number): Confidence | null {
    if (isNaN(odds)) return null;
    if (odds <= 1.3) return 'best_bet';
    if (odds <= 1.7) return 'high';
    if (odds <= 2.2) return 'medium';
    return 'low';
  }

  private extractDate(text: string, fetchedAt: Date): string {
    const match = text.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
    if (match) {
      const day = match[1]!.padStart(2, '0');
      const month = match[2]!.padStart(2, '0');
      const year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : String(fetchedAt.getFullYear());
      return `${year}-${month}-${day}`;
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
