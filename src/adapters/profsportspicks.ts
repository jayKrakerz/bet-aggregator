import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, PickType, Side, Confidence } from '../types/prediction.js';

/**
 * Professional Sports Picks adapter.
 *
 * WordPress site embedding sportscapping.com picks inline.
 * Same div.free-pick-col structure as SportsCapping and BoydsBets.
 * Server-rendered, no Playwright needed.
 */
export class ProfSportsPicksAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'profsportspicks',
    name: 'Professional Sports Picks',
    baseUrl: 'https://professionalsportspicks.com',
    fetchMethod: 'http',
    paths: {
      nba: '/free-sports-picks/',
      nfl: '/free-sports-picks/',
      mlb: '/free-sports-picks/',
      nhl: '/free-sports-picks/',
      ncaab: '/free-sports-picks/',
    },
    cron: '0 0 9,13,17,21 * * *',
    rateLimitMs: 5000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Sport label to filter when using the all-sports page
    const sportLabels: Record<string, string[]> = {
      nba: ['NBA'],
      nfl: ['NFL'],
      mlb: ['MLB'],
      nhl: ['NHL'],
      ncaab: ['NCAA-B', 'NCAAB'],
    };
    const validLabels = sportLabels[sport];

    $('div.free-pick-col').each((_i, el) => {
      const $card = $(el);

      // Filter by sport if on the all-sports page
      const sportLabel = $card.find('span.free-pick-sport').text().trim();
      if (validLabels && !validLabels.some(l => sportLabel.toUpperCase().includes(l))) return;

      const expert = $card.find('h3 > a').first().text().trim()
        || $card.find('div.content-heading > h3').text().trim();

      const gameText = $card.find('div.free-pick-game').text().trim();
      const matchupText = gameText.replace(sportLabel, '').replace(/^\s*\|\s*/, '').trim();

      const matchup = this.parseMatchup(matchupText);
      if (!matchup) return;

      const timeText = $card.find('div.free-pick-time').text().trim();
      const gameDate = this.parseDateFromTime(timeText) || fetchedAt.toISOString().split('T')[0]!;

      const pickText = $card.find('div.pick-result b, div.free-pick-green b').text().trim()
        .replace(/½/g, '.5');
      if (!pickText) return;

      const pick = this.parsePickText(pickText, matchup);

      const analysis = $card.find('div.free-pick-game-analysis-head').next('div').find('p').text().trim().slice(0, 300) || null;

      // Extract confidence from analysis text (e.g. "8*" = high, "1*" = low)
      const starMatch = analysis?.match(/(\d+)\*/);
      const confidence = starMatch
        ? (parseInt(starMatch[1]!, 10) >= 5 ? 'high' : parseInt(starMatch[1]!, 10) >= 3 ? 'medium' : 'low') as Confidence
        : pick.confidence;

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
        pickerName: expert || 'Professional Sports Picks',
        confidence,
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
    const ouMatch = text.match(/^(OVER|UNDER)\s+([\d.]+)\s*([-+]\d+)?/i);
    if (ouMatch) {
      return {
        pickType: 'over_under',
        side: ouMatch[1]!.toLowerCase() === 'over' ? 'over' : 'under',
        value: parseFloat(ouMatch[2]!),
        confidence: ouMatch[3] ? this.oddsToConf(parseInt(ouMatch[3], 10)) : 'medium',
      };
    }

    const spreadMatch = text.match(/^(.+?)\s+([-+][\d.]+)\s+([-+]\d+)/);
    if (spreadMatch) {
      return {
        pickType: 'spread',
        side: this.teamToSide(spreadMatch[1]!.trim(), matchup.home, matchup.away),
        value: parseFloat(spreadMatch[2]!),
        confidence: this.oddsToConf(parseInt(spreadMatch[3]!, 10)),
      };
    }

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
