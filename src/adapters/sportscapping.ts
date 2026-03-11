import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side, Confidence } from '../types/prediction.js';

/**
 * SportsCapping adapter.
 *
 * Joomla site, server-rendered. Same sportscapping.com pick card structure
 * as BoydsBets and ProfessionalSportsPicks. Each pick in `div.free-pick-col`:
 *   div.content-heading > h3      - expert name
 *   div.free-pick-time            - "Mar 03 '26, 10:40 PM in 2h"
 *   div.free-pick-game            - "NBA | Pelicans vs Lakers"
 *   div.free-pick-green b         - "OVER 239 -110" or "Pelicans +8½ -110 at Buckeye"
 *   div after analysis-head       - analysis text
 *   div.user-backend-release-time - "Released on Mar 03 at 04:51 am"
 *
 * Date group headers: h3.newdateheader ("March 03, 2026")
 */
export class SportsCappingAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'sportscapping',
    name: 'SportsCapping',
    baseUrl: 'https://www.sportscapping.com',
    fetchMethod: 'http',
    paths: {
      nba: '/free-nba-picks.html',
      nfl: '/free-nfl-picks.html',
      mlb: '/free-mlb-picks.html',
      nhl: '/free-nhl-picks.html',
      ncaab: '/free-college-basketball-picks.html',
    },
    cron: '0 0 9,13,17,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Track current date from h3.newdateheader siblings
    let currentDate = fetchedAt.toISOString().split('T')[0]!;

    // Iterate all children of the main container to track date headers
    $('h3.newdateheader, div.free-pick-col').each((_i, el) => {
      const $el = $(el);

      // Date header
      if ($el.is('h3.newdateheader')) {
        const parsed = this.parseLongDate($el.text().trim());
        if (parsed) currentDate = parsed;
        return;
      }

      // Pick card
      const expert = $el.find('div.content-heading > h3').text().trim()
        || $el.find('h3 > a').first().text().trim();

      const gameText = $el.find('div.free-pick-game').text().trim();
      const sportLabel = $el.find('span.free-pick-sport').text().trim();
      const matchupText = gameText.replace(sportLabel, '').replace(/^\s*\|\s*/, '').trim();

      const matchup = this.parseMatchup(matchupText);
      if (!matchup) return;

      const timeText = $el.find('div.free-pick-time').text().trim();
      const gameDate = this.parseDateFromTime(timeText) || currentDate;

      const pickText = $el.find('div.free-pick-green b, div.pick-result b').text().trim()
        .replace(/½/g, '.5');
      if (!pickText) return;

      const pick = this.parsePickText(pickText, matchup);

      const analysis = $el.find('div.free-pick-game-analysis-head').next('div').find('p').text().trim().slice(0, 300) || null;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: matchup.home,
        awayTeamRaw: matchup.away,
        gameDate,
        gameTime: timeText || null,
        pickType: pick.pickType,
        side: pick.side,
        value: pick.value,
        pickerName: expert || 'SportsCapping',
        confidence: pick.confidence,
        reasoning: analysis || pickText,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseMatchup(text: string): { home: string; away: string } | null {
    const match = text.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
  }

  private parsePickText(
    text: string,
    matchup: { home: string; away: string },
  ): { pickType: PickType; side: Side; value: number | null; confidence: Confidence | null } {
    // Over/Under
    const ouMatch = text.match(/^(OVER|UNDER)\s+([\d.]+)\s*([-+]\d+)?/i);
    if (ouMatch) {
      return {
        pickType: 'over_under',
        side: ouMatch[1]!.toLowerCase() === 'over' ? 'over' : 'under',
        value: parseFloat(ouMatch[2]!),
        confidence: ouMatch[3] ? this.oddsToConf(parseInt(ouMatch[3], 10)) : 'medium',
      };
    }

    // Spread: "Pelicans +8.5 -110 at Buckeye"
    const spreadMatch = text.match(/^(.+?)\s+([-+][\d.]+)\s+([-+]\d+)/);
    if (spreadMatch) {
      const side = this.teamToSide(spreadMatch[1]!.trim(), matchup.home, matchup.away);
      return {
        pickType: 'spread',
        side,
        value: parseFloat(spreadMatch[2]!),
        confidence: this.oddsToConf(parseInt(spreadMatch[3]!, 10)),
      };
    }

    // Moneyline: "Kraken -138"
    const mlMatch = text.match(/^(.+?)\s+([-+]?\d+)/);
    if (mlMatch) {
      const side = this.teamToSide(mlMatch[1]!.trim(), matchup.home, matchup.away);
      const value = parseInt(mlMatch[2]!, 10);
      if (Math.abs(value) <= 30) {
        return { pickType: 'spread', side, value, confidence: 'medium' };
      }
      return { pickType: 'moneyline', side, value, confidence: 'medium' };
    }

    const lower = text.toLowerCase();
    const side = lower.includes('over') ? 'over' as Side :
      lower.includes('under') ? 'under' as Side :
        this.teamToSide(text, matchup.home, matchup.away);
    return { pickType: 'moneyline', side, value: null, confidence: null };
  }

  private parseLongDate(text: string): string | null {
    const months: Record<string, string> = {
      january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
      july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
    };
    const match = text.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/i);
    if (!match) return null;
    const m = months[match[1]!.toLowerCase()];
    if (!m) return null;
    return `${match[3]}-${m}-${match[2]!.padStart(2, '0')}`;
  }

  private parseDateFromTime(text: string): string | null {
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const match = text.match(/(\w{3})\s+(\d{1,2})\s+'(\d{2})/);
    if (!match) return null;
    const m = months[match[1]!.toLowerCase()];
    if (!m) return null;
    return `20${match[3]}-${m}-${match[2]!.padStart(2, '0')}`;
  }

  private teamToSide(pickTeam: string, home: string, away: string): Side {
    const pickLower = pickTeam.toLowerCase();
    const homeWords = home.toLowerCase().split(/\s+/);
    const awayWords = away.toLowerCase().split(/\s+/);
    if (awayWords.some(w => w.length > 2 && pickLower.includes(w))) return 'away';
    if (homeWords.some(w => w.length > 2 && pickLower.includes(w))) return 'home';
    return 'home';
  }

  private oddsToConf(odds: number): Confidence | null {
    const abs = Math.abs(odds);
    if (abs >= 200) return 'high';
    if (abs >= 150) return 'medium';
    return 'low';
  }
}
