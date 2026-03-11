import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Tipstrr adapter.
 *
 * STATUS: BROKEN - /free-football-tips returns 404 as of 2026-03-10.
 * The site has restructured; free tips may have moved to a different URL.
 *
 * Tipstrr.com is a community tipping platform with free football tips.
 *
 * Expected page structure (free tips page):
 * - Tips listed as `.tip-card` or `.free-tip` containers
 * - Each tip contains:
 *   - `.tipster-name` or `.author`: name of the tipster
 *   - `.match-info` or `.event`: "Home vs Away" or "Home - Away"
 *   - `.tip-selection`: The pick (e.g., "Home Win", "Draw", "Over 2.5")
 *   - `.tip-odds`: Decimal odds
 *   - `.tip-date`: Date of the match
 *   - `.sport-tag` or `.league`: League/sport info
 *   - `.profit` or `.roi`: Tipster's track record stats
 *
 * Tips may require JavaScript to load; try HTTP first, fallback to browser.
 */
export class TipstrrAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'tipstrr',
    name: 'Tipstrr',
    baseUrl: 'https://www.tipstrr.com',
    fetchMethod: 'http',
    paths: {
      football: '/free-football-tips',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('.tip-card, .free-tip, .tip-item, .tip-row').each((_i, el) => {
      const $el = $(el);

      // Extract match info
      const matchText = $el.find('.match-info, .event, .match, .event-name').text().trim();
      const teams = this.parseTeams(matchText);
      if (!teams) return;

      // Extract tip selection
      const selection = $el.find('.tip-selection, .selection, .pick, .tip-pick').text().trim();
      const { side, pickType } = this.parseSelection(selection);
      if (!side) return;

      // Tipster info
      const tipster = $el.find('.tipster-name, .author, .tipster').text().trim();
      const oddsText = $el.find('.tip-odds, .odds, .odds-value').text().trim();
      const odds = parseFloat(oddsText);
      const dateText = $el.find('.tip-date, .date, .event-date').text().trim();
      const league = $el.find('.sport-tag, .league, .competition').text().trim();

      // Track record for reasoning
      const roi = $el.find('.profit, .roi, .yield').text().trim();

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: teams.home,
        awayTeamRaw: teams.away,
        gameDate: this.extractDate(dateText, fetchedAt),
        gameTime: null,
        pickType,
        side,
        value: pickType === 'over_under' ? this.extractTotal(selection) : null,
        pickerName: tipster || 'Tipstrr Community',
        confidence: this.oddsToConfidence(odds),
        reasoning: [
          league,
          !isNaN(odds) ? `Odds: ${odds}` : '',
          roi ? `ROI: ${roi}` : '',
        ].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseTeams(text: string): { home: string; away: string } | null {
    let parts = text.split(/\s+vs\.?\s+/i);
    if (parts.length < 2) parts = text.split(/\s+-\s+/);
    if (parts.length < 2) parts = text.split(/\s+v\s+/i);
    if (parts.length < 2) return null;
    const home = parts[0]!.trim();
    const away = parts.slice(1).join('-').trim();
    if (!home || !away) return null;
    return { home, away };
  }

  private parseSelection(text: string): { side: Side | null; pickType: 'moneyline' | 'over_under' } {
    const t = text.toUpperCase().trim();
    if (t.includes('OVER')) return { side: 'over', pickType: 'over_under' };
    if (t.includes('UNDER')) return { side: 'under', pickType: 'over_under' };
    if (t.includes('HOME WIN') || t === '1' || t === 'HOME') return { side: 'home', pickType: 'moneyline' };
    if (t.includes('AWAY WIN') || t === '2' || t === 'AWAY') return { side: 'away', pickType: 'moneyline' };
    if (t.includes('DRAW') || t === 'X') return { side: 'draw', pickType: 'moneyline' };
    // Double chance
    if (t.includes('HOME OR DRAW') || t === '1X') return { side: 'home', pickType: 'moneyline' };
    if (t.includes('AWAY OR DRAW') || t === 'X2') return { side: 'away', pickType: 'moneyline' };
    return { side: null, pickType: 'moneyline' };
  }

  private extractTotal(text: string): number | null {
    const match = text.match(/([\d.]+)/);
    return match ? parseFloat(match[1]!) : 2.5;
  }

  private oddsToConfidence(odds: number): Confidence | null {
    if (isNaN(odds)) return null;
    if (odds <= 1.3) return 'best_bet';
    if (odds <= 1.7) return 'high';
    if (odds <= 2.2) return 'medium';
    return 'low';
  }

  private extractDate(text: string, fetchedAt: Date): string {
    const match = text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (match) {
      const day = match[1]!.padStart(2, '0');
      const month = match[2]!.padStart(2, '0');
      const year = match[3]!.length === 2 ? `20${match[3]}` : match[3]!;
      return `${year}-${month}-${day}`;
    }
    // Try "Today", "Tomorrow" keywords
    const t = text.toLowerCase();
    if (t.includes('today')) return fetchedAt.toISOString().split('T')[0]!;
    if (t.includes('tomorrow')) {
      const tom = new Date(fetchedAt);
      tom.setDate(tom.getDate() + 1);
      return tom.toISOString().split('T')[0]!;
    }
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
