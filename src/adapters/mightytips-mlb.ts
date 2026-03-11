import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side } from '../types/prediction.js';

/**
 * MightyTips MLB adapter.
 *
 * STATUS: UNFIXABLE - /mlb-predictions/ returns 404 "page not found" as of
 * 2026-03-10. MightyTips has removed all non-football sports prediction pages.
 * The site navigation only links to football (soccer) predictions now.
 * This adapter cannot produce predictions until a valid URL is found.
 */
export class MightyTipsMlbAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'mightytips-mlb',
    name: 'MightyTips MLB',
    baseUrl: 'https://www.mightytips.com',
    fetchMethod: 'http',
    paths: {
      mlb: '/mlb-predictions/',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 3000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Detect 404 / error pages early
    const title = $('title').text().toLowerCase();
    if (title.includes('cannot be found') || title.includes('not found') || title.includes('404')) {
      return predictions;
    }

    $('.prediction-card, .tip-card, .betting-tip').each((_i, el) => {
      const $card = $(el);

      // Team names
      const homeTeamRaw = $card.find('.home-team, .team-home, .team:last-child').text().trim();
      const awayTeamRaw = $card.find('.away-team, .team-away, .team:first-child').text().trim();

      if (!homeTeamRaw || !awayTeamRaw) {
        // Fallback: parse from matchup text
        const matchText = $card.find('.teams-block, .matchup, .prediction-card__teams').text().trim();
        const parsed = this.parseMatchup(matchText);
        if (!parsed) return;
        // Use parsed but continue below
      }

      if (!homeTeamRaw || !awayTeamRaw) return;

      // Pick
      const pickText = $card.find('.prediction-card__pick, .tip-value, .pick-value').text().trim();
      const pickType = this.inferPickType(pickText);
      const side = this.resolveSide(pickText, homeTeamRaw, awayTeamRaw);

      // Value (odds or spread)
      const oddsText = $card.find('.prediction-card__odds, .odds-value').text().trim();
      const value = this.parseMoneylineValue(oddsText);

      // Date
      const dateText = $card.find('.prediction-card__date, .match-date, .date').text().trim();
      const gameDate = this.extractDate(dateText) || today;

      // Game time
      const gameTime = $card.find('.match-time, .time').text().trim() || null;

      // Tipster
      const pickerName = $card.find('.tipster-name, .author-name').text().trim() || 'MightyTips';

      // Confidence
      const confText = $card.find('.confidence, .rating, .stars').text().trim();
      const confidence = this.inferConfidence(confText);

      // Reasoning
      const reasoning = $card.find('.prediction-card__analysis, .analysis, .tip-reason').text().trim().slice(0, 300) || null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw,
        awayTeamRaw,
        gameDate,
        gameTime,
        pickType,
        side,
        value,
        pickerName,
        confidence,
        reasoning,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseMatchup(text: string): { home: string; away: string } | null {
    const match = text.match(/^(.+?)\s+(?:vs\.?|@|at)\s+(.+?)$/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
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

  private extractDate(text: string): string | null {
    // "March 10, 2026" or "03/10/2026" or "2026-03-10"
    const isoMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1]!;

    const usMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (usMatch) {
      return `${usMatch[3]}-${usMatch[1]!.padStart(2, '0')}-${usMatch[2]!.padStart(2, '0')}`;
    }

    const longMatch = text.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (longMatch) {
      const month = this.monthToNum(longMatch[1]!);
      if (month) return `${longMatch[3]}-${month}-${longMatch[2]!.padStart(2, '0')}`;
    }

    return null;
  }

  private monthToNum(month: string): string | null {
    const months: Record<string, string> = {
      january: '01', february: '02', march: '03', april: '04',
      may: '05', june: '06', july: '07', august: '08',
      september: '09', october: '10', november: '11', december: '12',
    };
    return months[month.toLowerCase()] ?? null;
  }
}
