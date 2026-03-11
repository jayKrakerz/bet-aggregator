import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side, Confidence } from '../types/prediction.js';

/**
 * Boyd's Bets adapter.
 *
 * WordPress site with picks embedded from sportscapping.com.
 * Server-rendered HTML. Each pick is in a `div.free-pick-col`:
 *   h3 > a                       - expert name
 *   div.free-pick-time            - "Mar 03 '26, 8:10 PM in 5h"
 *   div.free-pick-game            - "Spurs vs 76ers" with span.free-pick-sport
 *   div.pick-result b             - "Spurs -7.5 -105 at Draft Kings"
 *   div after analysis-head > p   - analysis text
 *   div.pick-release-time         - "Pick Released on Mar 03 at 02:24 pm"
 */
export class BoydsBetsAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'boydsbets',
    name: "Boyd's Bets",
    baseUrl: 'https://www.boydsbets.com',
    fetchMethod: 'http',
    paths: {
      nba: '/free-nba-picks/',
      nfl: '/free-nfl-picks/',
      mlb: '/free-mlb-picks/',
      nhl: '/free-nhl-picks/',
      ncaab: '/free-college-basketball-picks/',
    },
    cron: '0 0 9,13,17,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    $('div.free-pick-col').each((_i, el) => {
      const $card = $(el);

      // Expert name
      const expert = $card.find('h3 > a').first().text().trim();

      // Game info
      const gameText = $card.find('div.free-pick-game').text().trim();
      // Remove sport label like "NBA" from the beginning
      const sportLabel = $card.find('span.free-pick-sport').text().trim();
      const matchupText = gameText.replace(sportLabel, '').replace(/^\s*\|\s*/, '').trim();

      const matchup = this.parseMatchup(matchupText);
      if (!matchup) return;

      // Date/time: "Mar 03 '26, 8:10 PM in 5h"
      const timeText = $card.find('div.free-pick-time').text().trim();
      const gameDate = this.parseDateFromTime(timeText) || fetchedAt.toISOString().split('T')[0]!;

      // Pick text: "Spurs -7.5 -105 at Draft Kings" or "OVER 239 -110"
      const pickText = $card.find('div.pick-result b').text().trim()
        // Handle HTML entities like &frac12; for .5
        .replace(/½/g, '.5');

      if (!pickText) return;

      const pick = this.parsePickText(pickText, matchup);

      // Analysis
      const analysis = $card.find('div.free-pick-game-analysis-head').next('div').find('p').text().trim().slice(0, 300) || null;

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
        pickerName: expert || "Boyd's Bets Expert",
        confidence: pick.confidence,
        reasoning: analysis || pickText,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseMatchup(text: string): { home: string; away: string } | null {
    // "Spurs vs 76ers" or "Knicks vs Raptors"
    const match = text.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
    if (!match) return null;
    return { away: match[1]!.trim(), home: match[2]!.trim() };
  }

  private parsePickText(
    text: string,
    matchup: { home: string; away: string },
  ): { pickType: PickType; side: Side; value: number | null; confidence: Confidence | null } {
    const lower = text.toLowerCase();

    // Over/Under: "OVER 239 -110" or "UNDER 230.5 -110"
    const ouMatch = text.match(/^(OVER|UNDER)\s+([\d.]+)\s*([-+]\d+)?/i);
    if (ouMatch) {
      return {
        pickType: 'over_under',
        side: ouMatch[1]!.toLowerCase() === 'over' ? 'over' : 'under',
        value: parseFloat(ouMatch[2]!),
        confidence: ouMatch[3] ? this.oddsToConf(parseInt(ouMatch[3], 10)) : 'medium',
      };
    }

    // Spread: "Spurs -7.5 -105 at Draft Kings" or "Knicks -2.5 -110 at PlayMGM"
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

    // Moneyline: "Heat -13 -110 at circa" (this looks like spread but could be ML too)
    const mlMatch = text.match(/^(.+?)\s+([-+]?\d+)/);
    if (mlMatch) {
      const side = this.teamToSide(mlMatch[1]!.trim(), matchup.home, matchup.away);
      const value = parseInt(mlMatch[2]!, 10);
      // If value looks like a spread (small number), treat as spread
      if (Math.abs(value) <= 30) {
        return {
          pickType: 'spread',
          side,
          value,
          confidence: 'medium',
        };
      }
      return {
        pickType: 'moneyline',
        side,
        value,
        confidence: 'medium',
      };
    }

    // Fallback: just a team name
    const side = lower.includes('over') ? 'over' as Side :
      lower.includes('under') ? 'under' as Side :
        this.teamToSide(text, matchup.home, matchup.away);
    return { pickType: 'moneyline', side, value: null, confidence: null };
  }

  private parseDateFromTime(text: string): string | null {
    // "Mar 03 '26, 8:10 PM in 5h"
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const match = text.match(/(\w{3})\s+(\d{1,2})\s+'(\d{2})/);
    if (!match) return null;
    const m = months[match[1]!.toLowerCase()];
    if (!m) return null;
    const year = `20${match[3]}`;
    return `${year}-${m}-${match[2]!.padStart(2, '0')}`;
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
