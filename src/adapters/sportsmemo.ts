import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side, Confidence } from '../types/prediction.js';

/**
 * SportsMemo adapter.
 *
 * Server-rendered HTML. Pick data is in `div.plays-column-inner` cards:
 *   .plays-two h3 a          - expert name
 *   p with "Event:"          - "(547) Away at (548) Home: MarketType"
 *   p with "Date/Time:"      - "March 3, 2026 10:40 PM EST"
 *   h3.orange                - pick headline "Free NBA Pick Today: Total Over 242.5 (-110)"
 *   h3.orange + p            - analysis text
 */
export class SportsMemoAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'sportsmemo',
    name: 'SportsMemo',
    baseUrl: 'https://www.sportsmemo.com',
    fetchMethod: 'http',
    paths: {
      nba: '/free-sports-picks/nba',
      nfl: '/free-sports-picks/nfl',
      mlb: '/free-sports-picks/mlb',
      nhl: '/free-sports-picks/nhl',
      ncaab: '/free-sports-picks/college-basketball',
    },
    cron: '0 0 9,13,17,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('div.plays-column-inner').each((_i, el) => {
      const $card = $(el);
      const $plays = $card.find('.plays-two');

      // Expert name
      const expert = $plays.find('h3').first().find('a').first().text().trim();

      // Event line
      let eventText = '';
      $plays.find('p').each((_j, p) => {
        const text = $(p).text();
        if (text.includes('Event:')) {
          eventText = text.replace(/.*Event:\s*/i, '').trim();
        }
      });
      if (!eventText) return;

      const event = this.parseEventLine(eventText);
      if (!event) return;

      // Date/Time
      let dateTimeText = '';
      $plays.find('p').each((_j, p) => {
        const text = $(p).text();
        if (text.includes('Date/Time:')) {
          dateTimeText = text.replace(/.*Date\/Time:\s*/i, '').trim();
        }
      });

      // Pick headline
      const pickHeadline = $plays.find('h3.orange').text().trim();
      const pickText = pickHeadline.replace(/Free\s+.+?\s+Pick\s+Today:\s*/i, '').trim();
      if (!pickText) return;

      const pick = this.parsePickText(pickText, event);
      const gameDate = this.parseDateText(dateTimeText) || fetchedAt.toISOString().split('T')[0]!;

      // Analysis
      const analysis = $plays.find('h3.orange').next('p').text().trim().slice(0, 300) || null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: event.home,
        awayTeamRaw: event.away,
        gameDate,
        gameTime: dateTimeText || null,
        pickType: pick.pickType,
        side: pick.side,
        value: pick.value,
        pickerName: expert || 'SportsMemo Expert',
        confidence: pick.confidence,
        reasoning: analysis,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseEventLine(text: string): { away: string; home: string; marketType: string } | null {
    const cleaned = text.replace(/\(\d+\)\s*/g, '');
    const colonIdx = cleaned.lastIndexOf(':');
    let marketType = '';
    let matchText = cleaned;
    if (colonIdx > 0) {
      marketType = cleaned.slice(colonIdx + 1).trim();
      matchText = cleaned.slice(0, colonIdx).trim();
    }

    const atMatch = matchText.match(/^(.+?)\s+at\s+(.+)$/i);
    if (atMatch) {
      return { away: atMatch[1]!.trim(), home: atMatch[2]!.trim(), marketType };
    }

    const vsMatch = matchText.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
    if (vsMatch) {
      return { home: vsMatch[1]!.trim(), away: vsMatch[2]!.trim(), marketType };
    }

    return null;
  }

  private parsePickText(
    text: string,
    event: { marketType: string; home: string; away: string },
  ): { pickType: PickType; side: Side; value: number | null; confidence: Confidence | null } {
    const mtLower = event.marketType.toLowerCase();

    // Total Over/Under: "Total Over 242.5 (-110)"
    const totalMatch = text.match(/Total\s+(Over|Under)\s+([\d.]+)\s*\(([-+]\d+)\)/i);
    if (totalMatch) {
      return {
        pickType: 'over_under',
        side: totalMatch[1]!.toLowerCase() === 'over' ? 'over' : 'under',
        value: parseFloat(totalMatch[2]!),
        confidence: this.oddsToConf(parseInt(totalMatch[3]!, 10)),
      };
    }

    // Over/Under without "Total": "Over 18.5 (-111)"
    const ouMatch = text.match(/(Over|Under)\s+([\d.]+)\s*\(([-+]\d+)\)/i);
    if (ouMatch && (mtLower.includes('total') || mtLower.includes('over') || mtLower.includes('under') || mtLower.includes('points') || mtLower.includes('rebounds'))) {
      return {
        pickType: mtLower.includes('points') || mtLower.includes('rebounds') || mtLower.includes('assists') ? 'prop' : 'over_under',
        side: ouMatch[1]!.toLowerCase() === 'over' ? 'over' : 'under',
        value: parseFloat(ouMatch[2]!),
        confidence: this.oddsToConf(parseInt(ouMatch[3]!, 10)),
      };
    }

    // Spread: "Memphis Grizzlies +14.5 (-115)"
    const spreadMatch = text.match(/^(.+?)\s+([-+][\d.]+)\s*\(([-+]\d+)\)$/);
    if (spreadMatch) {
      const side = this.teamToSide(spreadMatch[1]!.trim(), event.home, event.away);
      return {
        pickType: 'spread',
        side,
        value: parseFloat(spreadMatch[2]!),
        confidence: this.oddsToConf(parseInt(spreadMatch[3]!, 10)),
      };
    }

    // Moneyline: "Ottawa Senators 105" or "Tampa Bay Lightning -140"
    const mlMatch = text.match(/^(.+?)\s+([-+]?\d+)$/);
    if (mlMatch) {
      const side = this.teamToSide(mlMatch[1]!.trim(), event.home, event.away);
      return {
        pickType: 'moneyline',
        side,
        value: parseInt(mlMatch[2]!, 10),
        confidence: this.oddsToConf(parseInt(mlMatch[2]!, 10)),
      };
    }

    return { pickType: 'moneyline', side: 'home', value: null, confidence: null };
  }

  private teamToSide(pickTeam: string, home: string, away: string): Side {
    const pickLower = pickTeam.toLowerCase();
    const homeWords = home.toLowerCase().split(/\s+/);
    const awayWords = away.toLowerCase().split(/\s+/);
    if (awayWords.some(w => w.length > 2 && pickLower.includes(w))) return 'away';
    if (homeWords.some(w => w.length > 2 && pickLower.includes(w))) return 'home';
    return 'home';
  }

  private parseDateText(text: string): string | null {
    const months: Record<string, string> = {
      january: '01', february: '02', march: '03', april: '04',
      may: '05', june: '06', july: '07', august: '08',
      september: '09', october: '10', november: '11', december: '12',
    };
    const match = text.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (!match) return null;
    const m = months[match[1]!.toLowerCase()];
    if (!m) return null;
    return `${match[3]}-${m}-${match[2]!.padStart(2, '0')}`;
  }

  private oddsToConf(odds: number): Confidence | null {
    const abs = Math.abs(odds);
    if (abs >= 200) return 'high';
    if (abs >= 150) return 'medium';
    return 'low';
  }
}
