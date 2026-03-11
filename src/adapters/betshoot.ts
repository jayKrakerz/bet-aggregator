import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Betshoot adapter.
 *
 * STATUS: UNFIXABLE - /football-predictions/ is behind Cloudflare bot
 * protection as of 2026-03-10. The fetched snapshot contains a Cloudflare
 * "Just a moment..." / Turnstile challenge page instead of actual content.
 * The fetchMethod would need to be changed to 'browser' (Playwright) to
 * potentially bypass this, but Cloudflare may still block automated browsers.
 * This adapter cannot produce predictions until the Cloudflare issue is resolved.
 */
export class BetshootAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'betshoot',
    name: 'Betshoot',
    baseUrl: 'https://www.betshoot.com',
    fetchMethod: 'http',
    paths: {
      football: '/football-predictions/',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Detect Cloudflare challenge or error pages early
    const title = $('title').text().toLowerCase();
    if (title.includes('just a moment') || title.includes('not found') || title.includes('404')
        || title.includes('security') || title.includes('challenge')) {
      return predictions;
    }

    // Card layout
    $('.prediction-item, .match-card, .tip-card').each((_i, el) => {
      const $el = $(el);

      const matchText = $el.find('.teams, .match-title, .match-name').text().trim();
      const teams = this.parseTeams(matchText);
      if (!teams) return;

      const tipText = $el.find('.tip, .prediction-value, .pick').text().trim();
      const { side, pickType } = this.parseTip(tipText);
      if (!side) return;

      const dateText = $el.find('.date, .match-date').text().trim();
      const league = $el.find('.league-name, .league, .competition').text().trim();
      const tipster = $el.find('.tipster, .author').text().trim();
      const oddsText = $el.find('.odds, .odd').text().trim();
      const odds = parseFloat(oddsText);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: teams.home,
        awayTeamRaw: teams.away,
        gameDate: this.extractDate(dateText, fetchedAt),
        gameTime: null,
        pickType,
        side,
        value: pickType === 'over_under' ? this.extractTotalValue(tipText) : null,
        pickerName: tipster || 'Betshoot',
        confidence: this.oddsToConfidence(odds),
        reasoning: [league, !isNaN(odds) ? `Odds: ${odds}` : ''].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    // Fallback: table layout
    if (predictions.length === 0) {
      $('table tbody tr').each((_i, el) => {
        const cells = $(el).find('td');
        if (cells.length < 4) return;

        const matchText = $(cells[1]).text().trim();
        const teams = this.parseTeams(matchText);
        if (!teams) return;

        const tipText = $(cells[3]).text().trim() || $(cells[2]).text().trim();
        const { side, pickType } = this.parseTip(tipText);
        if (!side) return;

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: teams.home,
          awayTeamRaw: teams.away,
          gameDate: this.extractDate($(cells[0]).text().trim(), fetchedAt),
          gameTime: null,
          pickType,
          side,
          value: pickType === 'over_under' ? this.extractTotalValue(tipText) : null,
          pickerName: 'Betshoot',
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
    if (parts.length < 2) parts = text.split(/\s+-\s+/);
    if (parts.length < 2) return null;
    const home = parts[0]!.trim();
    const away = parts.slice(1).join('-').trim();
    if (!home || !away) return null;
    return { home, away };
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

  private extractTotalValue(text: string): number | null {
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
    return fetchedAt.toISOString().split('T')[0]!;
  }
}
