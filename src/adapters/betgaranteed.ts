import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * BetGaranteed adapter.
 *
 * Scrapes football predictions from betgaranteed.com.
 * Layout: prediction cards or rows with teams, 1X2 tip, and probability.
 */
export class BetgaranteedAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'betgaranteed',
    name: 'BetGaranteed',
    baseUrl: 'https://www.betgaranteed.com',
    fetchMethod: 'http',
    paths: {
      football: '/football-predictions',
    },
    cron: '0 0 7,13,19 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];
    const today = fetchedAt.toISOString().split('T')[0]!;

    // Strategy 1: Card / div-based layout
    $('.prediction-card, .match-card, .prediction-item, .game-item, .tip-item').each((_i, el) => {
      const $card = $(el);

      const homeTeam =
        $card.find('.home-team, .home, .team-home, .team-1, .team1').first().text().trim();
      const awayTeam =
        $card.find('.away-team, .away, .team-away, .team-2, .team2').first().text().trim();

      let home = homeTeam;
      let away = awayTeam;
      if (!home || !away) {
        const teamsText = $card.find('.teams, .match, .fixture, .match-teams').first().text().trim();
        const parsed = this.parseTeamsString(teamsText);
        if (parsed) {
          home = parsed.home;
          away = parsed.away;
        }
      }
      if (!home || !away) return;

      const league =
        $card.find('.league, .competition, .comp, .country').first().text().trim() || '';

      const tip =
        $card.find('.tip, .prediction, .pick, .pred, .recommended-bet').first().text().trim() ||
        $card.find('strong, b, .badge').first().text().trim();

      const probText =
        $card.find('.probability, .prob, .chance, .percentage, .confidence').first().text().trim();
      const probability = this.extractPercentage(probText);

      const dateText =
        $card.find('.date, .match-date, .game-date').first().text().trim();
      const gameDate = this.extractDate(dateText, fetchedAt) || today;

      const timeText =
        $card.find('.time, .kick-off, .ko-time, .match-time').first().text().trim();
      const gameTime = this.extractTime(timeText);

      const side = this.mapTipToSide(tip);
      if (!side) return;

      const isOverUnder = this.isOverUnderTip(tip);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: home,
        awayTeamRaw: away,
        gameDate,
        gameTime,
        pickType: isOverUnder ? 'over_under' : 'moneyline',
        side,
        value: isOverUnder ? (this.parseTotalValue(tip) ?? 2.5) : null,
        pickerName: 'BetGaranteed',
        confidence: this.percentToConfidence(probability),
        reasoning: [league, probability ? `Prob: ${probability}%` : ''].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });

      // Check for secondary over/under prediction
      const ouText = $card.find('.over-under, .ou-tip, .total-goals').first().text().trim();
      if (ouText) {
        const ouSide = this.mapTipToSide(ouText);
        if (ouSide && (ouSide === 'over' || ouSide === 'under')) {
          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: home,
            awayTeamRaw: away,
            gameDate,
            gameTime,
            pickType: 'over_under',
            side: ouSide,
            value: this.parseTotalValue(ouText) ?? 2.5,
            pickerName: 'BetGaranteed',
            confidence: this.percentToConfidence(probability),
            reasoning: [league, `O/U: ${ouText}`].filter(Boolean).join(' | ') || null,
            fetchedAt,
          });
        }
      }
    });

    // Strategy 2: Table fallback
    if (predictions.length === 0) {
      let currentLeague = '';

      $('table tbody tr, table.tips tr, table.predictions tr, .table tr').each((_i, el) => {
        const $row = $(el);

        if ($row.find('th').length > 0) return;

        // League headers
        const colspanCell = $row.find('td[colspan]');
        if (colspanCell.length > 0) {
          const text = colspanCell.text().trim();
          if (text.length > 2 && !/^\d+$/.test(text)) {
            currentLeague = text;
          }
          return;
        }

        if ($row.hasClass('league-header') || $row.hasClass('league')) {
          currentLeague = $row.text().trim();
          return;
        }

        const cells = $row.find('td');
        if (cells.length < 4) return;

        let home = '';
        let away = '';
        let tip = '';
        let probText = '';
        let dateText = '';
        let timeText = '';

        if (cells.length >= 7) {
          // date | time | league | home | away | tip | probability
          dateText = cells.eq(0).text().trim();
          timeText = cells.eq(1).text().trim();
          currentLeague = cells.eq(2).text().trim() || currentLeague;
          home = cells.eq(3).text().trim();
          away = cells.eq(4).text().trim();
          tip = cells.eq(5).text().trim();
          probText = cells.eq(6).text().trim();
        } else if (cells.length >= 6) {
          // league | home | away | tip | probability | odds
          currentLeague = cells.eq(0).text().trim() || currentLeague;
          home = cells.eq(1).text().trim();
          away = cells.eq(2).text().trim();
          tip = cells.eq(3).text().trim();
          probText = cells.eq(4).text().trim();
        } else if (cells.length >= 5) {
          // home | away | tip | probability | odds
          home = cells.eq(0).text().trim();
          away = cells.eq(1).text().trim();
          tip = cells.eq(2).text().trim();
          probText = cells.eq(3).text().trim();
        } else {
          // home | away | tip | probability
          home = cells.eq(0).text().trim();
          away = cells.eq(1).text().trim();
          tip = cells.eq(2).text().trim();
          probText = cells.eq(3).text().trim();
        }

        // Try extracting teams from a combined cell
        if (!home || !away) {
          for (let ci = 0; ci < Math.min(cells.length, 4); ci++) {
            const parsed = this.parseTeamsString(cells.eq(ci).text().trim());
            if (parsed) {
              home = parsed.home;
              away = parsed.away;
              break;
            }
          }
        }

        if (!home || !away) return;

        const side = this.mapTipToSide(tip);
        if (!side) return;

        const probability = this.extractPercentage(probText);
        const gameDate = this.extractDate(dateText, fetchedAt) || today;
        const gameTime = this.extractTime(timeText);
        const isOverUnder = this.isOverUnderTip(tip);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate,
          gameTime,
          pickType: isOverUnder ? 'over_under' : 'moneyline',
          side,
          value: isOverUnder ? (this.parseTotalValue(tip) ?? 2.5) : null,
          pickerName: 'BetGaranteed',
          confidence: this.percentToConfidence(probability),
          reasoning: [currentLeague, probability ? `Prob: ${probability}%` : ''].filter(Boolean).join(' | ') || null,
          fetchedAt,
        });
      });
    }

    return predictions;
  }

  private mapTipToSide(tip: string): Side | null {
    const t = tip.toUpperCase().trim();
    if (t === '1' || t === 'H' || t === 'HOME' || t === '1X') return 'home';
    if (t === '2' || t === 'A' || t === 'AWAY' || t === 'X2') return 'away';
    if (t === 'X' || t === 'D' || t === 'DRAW') return 'draw';
    if (t.startsWith('OVER') || t === 'OV' || /^O\d/.test(t)) return 'over';
    if (t.startsWith('UNDER') || t === 'UN' || /^U\d/.test(t)) return 'under';
    if (t === 'GG' || t === 'BTTS' || t === 'BTTS YES' || t === 'YES') return 'yes';
    if (t === 'NG' || t === 'BTTS NO' || t === 'NO') return 'no';
    return null;
  }

  private isOverUnderTip(tip: string): boolean {
    const t = tip.toUpperCase().trim();
    return t.startsWith('OVER') || t.startsWith('UNDER') ||
      t === 'OV' || t === 'UN' ||
      /^[OU]\d/.test(t);
  }

  private parseTeamsString(text: string): { home: string; away: string } | null {
    const match = text.match(/^(.+?)\s+(?:vs?\.?|[-–])\s+(.+)$/i);
    if (match && match[1] && match[2]) {
      return { home: match[1].trim(), away: match[2].trim() };
    }
    return null;
  }

  private extractPercentage(text: string): number | null {
    const match = text.match(/(\d{1,3})\s*%?/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num >= 0 && num <= 100) return num;
    }
    return null;
  }

  private percentToConfidence(pct: number | null): Confidence | null {
    if (pct === null) return null;
    if (pct >= 80) return 'best_bet';
    if (pct >= 65) return 'high';
    if (pct >= 45) return 'medium';
    return 'low';
  }

  private extractDate(text: string, fetchedAt: Date): string | null {
    const match = text.match(/(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?/);
    if (match) {
      const day = match[1]!.padStart(2, '0');
      const month = match[2]!.padStart(2, '0');
      const year = match[3]
        ? (match[3].length === 2 ? `20${match[3]}` : match[3])
        : String(fetchedAt.getFullYear());
      return `${year}-${month}-${day}`;
    }
    return null;
  }

  private extractTime(text: string): string | null {
    const match = text.match(/(\d{1,2}:\d{2})/);
    return match ? match[1]! : null;
  }
}
