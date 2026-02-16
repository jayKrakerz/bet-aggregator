import * as cheerio from 'cheerio';
import type { SiteAdapter, SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Confidence } from '../types/prediction.js';

export abstract class BaseAdapter implements SiteAdapter {
  abstract readonly config: SiteAdapterConfig;
  abstract parse(html: string, sport: string, fetchedAt: Date): RawPrediction[];

  protected load(html: string) {
    return cheerio.load(html);
  }

  protected parseSpreadValue(text: string): number | null {
    const cleaned = text.trim().replace(/PK/i, '0');
    const num = parseFloat(cleaned);
    return Number.isNaN(num) ? null : num;
  }

  protected parseMoneylineValue(text: string): number | null {
    const num = parseInt(text.trim(), 10);
    return Number.isNaN(num) ? null : num;
  }

  protected parseTotalValue(text: string): number | null {
    const match = text.match(/([\d.]+)/);
    return match?.[1] ? parseFloat(match[1]) : null;
  }

  protected inferPickType(text: string): PickType {
    const lower = text.toLowerCase();
    if (lower.includes('spread') || lower.includes('ats')) return 'spread';
    if (lower.includes('money') || lower.includes('ml')) return 'moneyline';
    if (lower.includes('over') || lower.includes('under') || lower.includes('total') || lower.includes('o/u'))
      return 'over_under';
    if (lower.includes('prop')) return 'prop';
    if (lower.includes('parlay')) return 'parlay';
    return 'spread';
  }

  protected inferConfidence(text: string): Confidence | null {
    const lower = text.toLowerCase();
    if (!lower) return null;
    if (lower.includes('best bet') || lower.includes('lock')) return 'best_bet';
    if (lower.includes('high') || lower.includes('strong')) return 'high';
    if (lower.includes('lean') || lower.includes('slight')) return 'low';
    return 'medium';
  }
}
