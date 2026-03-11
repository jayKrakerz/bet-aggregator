import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * SoccerEco adapter.
 *
 * Static HTML with Bootstrap cards grouped by league. Each match is an
 * `li.list-games-item` inside `ul.list-games`.
 *
 * Structure per match:
 *   a.matchesbar-link
 *     div.time > span.match-date__time          — kick-off time
 *     div.teams > div.home span.teamname         — home team
 *     div.teams > div.away span.teamname         — away team
 *     div.tournament div.sizeodd span[data-odds] — three odds (1/X/2)
 *     div.predimain > div.tipdisplay             — prediction (1, X, 2, 1X, X2)
 *     div.predimain > div:nth-child(2)           — O/U indicator
 *     div.predimain > div.lastscore              — predicted score
 *
 * JSON-LD SportsEvent blocks provide league name and startDate.
 */
export class SoccerEcoAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'soccereco',
    name: 'SoccerEco',
    baseUrl: 'https://www.soccereco.com',
    fetchMethod: 'http',
    paths: {
      football: '/predictions',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // Build league map from card headers
    const leagueMap = new Map<number, string>();
    $('div.card.mb-2').each((i, el) => {
      const leagueName = $(el).find('div.card-header span.margin5').text().trim();
      if (leagueName) leagueMap.set(i, leagueName);
    });

    // Process each match item
    $('li.list-games-item').each((_i, el) => {
      const $li = $(el);
      const $link = $li.find('a.matchesbar-link');
      if (!$link.length) return;

      // Teams
      const homeTeam = $link.find('div.home span.teamname').text().trim();
      const awayTeam = $link.find('div.away span.teamname').text().trim();
      if (!homeTeam || !awayTeam) return;

      // Time
      const timeText = $link.find('span.match-date__time').text().trim();
      const dateText = $link.find('span[data-date]').first().attr('data-date');
      let gameDate = fetchedAt.toISOString().split('T')[0]!;
      if (dateText) {
        const epoch = parseInt(dateText, 10);
        if (!isNaN(epoch)) {
          gameDate = new Date(epoch * 1000).toISOString().split('T')[0]!;
        }
      }

      // Odds (1/X/2)
      const oddsEls = $link.find('div.sizeodd span[data-odds]');
      const odds: number[] = [];
      oddsEls.each((_j, oddEl) => {
        const val = parseFloat($(oddEl).attr('data-odds') || $(oddEl).text().trim());
        if (!isNaN(val)) odds.push(val);
      });

      // Prediction
      const tipText = $link.find('div.tipdisplay').text().trim();
      const side = this.mapTipToSide(tipText);

      // Over/Under
      const predMain = $link.find('div.predimain');
      const ouText = predMain.children('div').eq(1).text().trim();
      const ouSide: Side | null = ouText === 'O' ? 'over' : ouText === 'U' ? 'under' : null;

      // Predicted score
      const predScore = $link.find('div.lastscore').text().trim();

      // League — find closest card ancestor
      const card = $li.closest('div.card.mb-2');
      const league = card.find('div.card-header span.margin5').text().trim();

      const reasoning = [
        league,
        odds.length >= 3 ? `Odds: ${odds[0]}/${odds[1]}/${odds[2]}` : '',
        predScore ? `Predicted: ${predScore}` : '',
      ].filter(Boolean).join(' | ') || null;

      // Confidence from odds
      const confidence = this.oddsToConfidence(odds, side);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: homeTeam,
        awayTeamRaw: awayTeam,
        gameDate,
        gameTime: timeText ? `${timeText} UTC` : null,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'SoccerEco',
        confidence,
        reasoning,
        fetchedAt,
      });

      // Over/under prediction
      if (ouSide) {
        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: homeTeam,
          awayTeamRaw: awayTeam,
          gameDate,
          gameTime: timeText ? `${timeText} UTC` : null,
          pickType: 'over_under',
          side: ouSide,
          value: 2.5,
          pickerName: 'SoccerEco',
          confidence: 'medium',
          reasoning: league || null,
          fetchedAt,
        });
      }
    });

    return predictions;
  }

  private mapTipToSide(tip: string): Side {
    if (tip === '1' || tip === '1X') return 'home';
    if (tip === '2' || tip === 'X2') return 'away';
    if (tip === 'X') return 'draw';
    return 'home';
  }

  private oddsToConfidence(odds: number[], side: Side): Confidence | null {
    if (odds.length < 3) return null;
    let odd: number;
    if (side === 'home') odd = odds[0]!;
    else if (side === 'draw') odd = odds[1]!;
    else odd = odds[2]!;

    // Lower odds = higher confidence (1.30 = strong fav, 3.00 = toss-up)
    if (odd <= 1.5) return 'best_bet';
    if (odd <= 2.0) return 'high';
    if (odd <= 2.8) return 'medium';
    return 'low';
  }
}
