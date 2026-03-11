import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * Free Super Tips adapter.
 *
 * Next.js site with all prediction data embedded in __NEXT_DATA__ JSON.
 * No DOM parsing needed — extract JSON directly from script tag.
 *
 * JSON path: props.pageProps.predictions[].competitions[].predictions[].tips[]
 * Each tip has: title (market), textOne (pick), odds, confidence, reasoning
 */
export class FreeSuperTipsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'freesupertips',
    name: 'Free Super Tips',
    baseUrl: 'https://www.freesupertips.com',
    fetchMethod: 'http',
    paths: {
      football: '/predictions/',
    },
    cron: '0 0 6,10,14,18 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const predictions: RawPrediction[] = [];

    // Extract __NEXT_DATA__ JSON
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return predictions;

    let nextData: any;
    try {
      nextData = JSON.parse(match[1]!);
    } catch {
      return predictions;
    }

    // Data was previously at props.pageProps.predictions but moved to
    // props.pageProps.responses.predictions in a Next.js restructuring.
    const dayGroups =
      nextData?.props?.pageProps?.responses?.predictions ??
      nextData?.props?.pageProps?.predictions;
    if (!Array.isArray(dayGroups)) return predictions;

    for (const day of dayGroups) {
      if (!Array.isArray(day.competitions)) continue;

      for (const comp of day.competitions) {
        const league = comp.name || '';
        if (!Array.isArray(comp.predictions)) continue;

        for (const pred of comp.predictions) {
          const teams = pred.teams;
          if (!Array.isArray(teams) || teams.length < 2) continue;

          const homeTeam = teams.find((t: any) => t.homeAway === 'home');
          const awayTeam = teams.find((t: any) => t.homeAway === 'away');
          if (!homeTeam?.name || !awayTeam?.name) continue;

          const gameDate = pred.startString
            ? pred.startString.split(' ')[0]!
            : fetchedAt.toISOString().split('T')[0]!;

          const tips = pred.tips;
          if (!Array.isArray(tips) || tips.length === 0) continue;

          for (const tip of tips) {
            const market = (tip.title || '').trim();
            const pickText = (tip.textOne || '').trim();
            if (!pickText) continue;

            const parsed = this.parseTip(market, pickText, homeTeam.name, awayTeam.name);

            const confNum = parseInt(tip.confidence || '0', 10);
            const confidence: Confidence | null = confNum >= 4 ? 'high' : confNum >= 2 ? 'medium' : 'low';

            const reasoning = tip.reasoning?.description
              ? (tip.reasoning.description as string).replace(/<[^>]+>/g, '').trim().slice(0, 300)
              : null;

            predictions.push({
              sourceId: this.config.id,
              sport,
              homeTeamRaw: homeTeam.name,
              awayTeamRaw: awayTeam.name,
              gameDate,
              gameTime: pred.startString || null,
              pickType: parsed.pickType,
              side: parsed.side,
              value: parsed.value,
              pickerName: 'Free Super Tips',
              confidence,
              reasoning: reasoning || `${market}: ${pickText}${league ? ` | ${league}` : ''}`,
              fetchedAt,
            });
          }
        }
      }
    }

    return predictions;
  }

  private parseTip(
    market: string,
    pickText: string,
    home: string,
    away: string,
  ): { pickType: RawPrediction['pickType']; side: Side; value: number | null } {
    const lower = pickText.toLowerCase();
    const marketLower = market.toLowerCase();

    // Over/Under markets
    if (marketLower.includes('over') || marketLower.includes('under') || lower.includes('over') || lower.includes('under')) {
      const ouMatch = pickText.match(/(over|under)\s*([\d.]+)/i);
      if (ouMatch) {
        return {
          pickType: 'over_under',
          side: ouMatch[1]!.toLowerCase() === 'over' ? 'over' : 'under',
          value: parseFloat(ouMatch[2]!),
        };
      }
    }

    // BTTS
    if (marketLower.includes('both teams') || lower.includes('btts')) {
      return {
        pickType: 'prop',
        side: lower.includes('yes') || lower.includes('to score') ? 'yes' : 'no',
        value: null,
      };
    }

    // Correct Score
    if (marketLower.includes('correct score')) {
      const scoreMatch = pickText.match(/(\d+)\s*-\s*(\d+)/);
      return {
        pickType: 'prop',
        side: 'home',
        value: scoreMatch ? parseInt(scoreMatch[1]!, 10) : null,
      };
    }

    // Full Time Result / 1X2
    if (lower.includes('draw')) return { pickType: 'moneyline', side: 'draw', value: null };
    if (lower.includes('win') || marketLower.includes('full time')) {
      const side = this.teamToSide(pickText, home, away);
      return { pickType: 'moneyline', side, value: null };
    }

    // Fallback
    return {
      pickType: 'moneyline',
      side: this.teamToSide(pickText, home, away),
      value: null,
    };
  }

  private teamToSide(text: string, home: string, away: string): Side {
    const lower = text.toLowerCase();
    if (lower.includes('draw')) return 'draw';
    const homeWords = home.toLowerCase().split(/\s+/);
    const awayWords = away.toLowerCase().split(/\s+/);
    if (awayWords.some(w => w.length > 2 && lower.includes(w))) return 'away';
    if (homeWords.some(w => w.length > 2 && lower.includes(w))) return 'home';
    return 'home';
  }
}
