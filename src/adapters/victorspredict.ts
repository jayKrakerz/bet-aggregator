import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * HelloPredict adapter (formerly VictorsPredict).
 *
 * Scrapes football predictions from hellopredict.com.
 * The site uses Laravel/Livewire. Content loads dynamically via Livewire
 * components. The football-predictions page shows matches grouped by league.
 *
 * Layout patterns:
 *   - Livewire-rendered match cards/rows
 *   - League headers grouping matches
 *   - Each match shows: home team, away team, prediction tip, odds
 *   - Tips are standard 1X2, Over/Under, BTTS format
 *
 * The HTML may contain wire:snapshot data with match info, or
 * server-rendered table/card layouts.
 */
export class VictorspredictAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'hellopredict',
    name: 'HelloPredict',
    baseUrl: 'https://www.hellopredict.com',
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

    // Strategy 1: Livewire wire:snapshot JSON data
    // Livewire 3 embeds component state in wire:snapshot attributes
    $('[wire\\:snapshot]').each((_i, el) => {
      try {
        const snapshot = $(el).attr('wire:snapshot');
        if (!snapshot) return;
        const data = JSON.parse(snapshot);
        const matches = data?.data?.matches || data?.data?.predictions || [];
        for (const match of matches) {
          const homeTeam = match.home_team || match.homeTeam || match.home || '';
          const awayTeam = match.away_team || match.awayTeam || match.away || '';
          if (!homeTeam || !awayTeam) continue;

          const tip = match.prediction || match.tip || match.pick || '';
          const odds = match.odds || match.odd || null;
          const league = match.league || match.competition || match.tournament || '';
          const time = match.time || match.kickoff || match.kick_off || null;
          const date = match.date || match.match_date || today;

          const side = this.mapTipToSide(tip);
          if (!side) continue;

          const isOverUnder = this.isOverUnderTip(tip);

          predictions.push({
            sourceId: this.config.id,
            sport,
            homeTeamRaw: homeTeam,
            awayTeamRaw: awayTeam,
            gameDate: this.normalizeDate(date, fetchedAt),
            gameTime: this.extractTime(time || ''),
            pickType: isOverUnder ? 'over_under' : this.isBtts(tip) ? 'prop' : 'moneyline',
            side,
            value: isOverUnder ? (this.parseTotalValue(tip) ?? 2.5) : null,
            pickerName: 'HelloPredict',
            confidence: odds ? this.oddsToConfidence(parseFloat(odds)) : null,
            reasoning: league || null,
            fetchedAt,
          });
        }
      } catch {
        // Skip invalid JSON
      }
    });

    if (predictions.length > 0) return predictions;

    // Strategy 2: Card-based layout
    const cardSelectors = [
      '.prediction-card', '.match-card', '.game-card', '.tip-card',
      '.match-item', '.prediction-item', '.fixture-card', '.match-row',
      '.event-card', '.prediction-block',
    ];

    for (const cardSel of cardSelectors) {
      if ($(cardSel).length === 0) continue;

      $(cardSel).each((_i, el) => {
        const $card = $(el);

        const homeTeam = this.extractText($card, [
          '.home-team', '.home', '.team-home', '.team1', '.team-a',
          '.teams .team:first-child', 'span.home',
        ]);
        const awayTeam = this.extractText($card, [
          '.away-team', '.away', '.team-away', '.team2', '.team-b',
          '.teams .team:last-child', 'span.away',
        ]);

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

        const league = this.extractText($card, [
          '.league', '.competition', '.comp-name', '.league-name', '.tournament',
        ]);
        const tip = this.extractText($card, [
          '.tip', '.prediction', '.pick', '.pred', '.prediction-value',
          '.market', '.bet-tip',
        ]);
        const oddsText = this.extractText($card, [
          '.odds', '.odd', '.price', '.odds-value',
        ]);
        const odds = parseFloat(oddsText) || null;

        const timeText = this.extractText($card, [
          '.time', '.kick-off', '.kickoff', '.match-time',
        ]);
        const dateText = this.extractText($card, [
          '.date', '.match-date', '.game-date',
        ]);

        const side = this.mapTipToSide(tip);
        if (!side) return;

        const isOverUnder = this.isOverUnderTip(tip);

        predictions.push({
          sourceId: this.config.id,
          sport,
          homeTeamRaw: home,
          awayTeamRaw: away,
          gameDate: this.normalizeDate(dateText, fetchedAt),
          gameTime: this.extractTime(timeText),
          pickType: isOverUnder ? 'over_under' : this.isBtts(tip) ? 'prop' : 'moneyline',
          side,
          value: isOverUnder ? (this.parseTotalValue(tip) ?? 2.5) : null,
          pickerName: 'HelloPredict',
          confidence: odds ? this.oddsToConfidence(odds) : null,
          reasoning: [league, odds ? `Odds: ${odds}` : ''].filter(Boolean).join(' | ') || null,
          fetchedAt,
        });
      });

      if (predictions.length > 0) return predictions;
    }

    // Strategy 3: Table-based layout
    let currentLeague = '';

    $('table tbody tr, table tr, .table tr').each((_i, el) => {
      const $row = $(el);

      if ($row.find('th').length > 0) return;

      // League header rows
      const colspanCell = $row.find('td[colspan]');
      if (colspanCell.length > 0) {
        const text = colspanCell.text().trim();
        if (text.length > 2 && !/\d{1,2}:\d{2}/.test(text)) {
          currentLeague = text;
        }
        return;
      }

      const cells = $row.find('td');
      if (cells.length < 4) return;

      let home = '';
      let away = '';
      let tip = '';
      let oddsText = '';
      let timeText = '';

      if (cells.length >= 6) {
        currentLeague = cells.eq(0).text().trim() || currentLeague;
        timeText = cells.eq(1).text().trim();
        home = cells.eq(2).text().trim();
        away = cells.eq(3).text().trim();
        tip = cells.eq(4).text().trim();
        oddsText = cells.eq(5).text().trim();
      } else if (cells.length >= 5) {
        home = cells.eq(0).text().trim();
        away = cells.eq(1).text().trim();
        tip = cells.eq(2).text().trim();
        oddsText = cells.eq(3).text().trim();
        timeText = cells.eq(4).text().trim();
      } else {
        home = cells.eq(0).text().trim();
        away = cells.eq(1).text().trim();
        tip = cells.eq(2).text().trim();
        oddsText = cells.eq(3).text().trim();
      }

      // Try parsing combined teams
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

      const odds = parseFloat(oddsText) || null;
      const isOverUnder = this.isOverUnderTip(tip);

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: home,
        awayTeamRaw: away,
        gameDate: today,
        gameTime: this.extractTime(timeText),
        pickType: isOverUnder ? 'over_under' : this.isBtts(tip) ? 'prop' : 'moneyline',
        side,
        value: isOverUnder ? (this.parseTotalValue(tip) ?? 2.5) : null,
        pickerName: 'HelloPredict',
        confidence: odds ? this.oddsToConfidence(odds) : null,
        reasoning: [currentLeague, odds ? `Odds: ${odds}` : ''].filter(Boolean).join(' | ') || null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private extractText(
    $el: ReturnType<ReturnType<typeof this.load>>,
    selectors: string[],
  ): string {
    for (const sel of selectors) {
      const text = $el.find(sel).first().text().trim();
      if (text) return text;
    }
    return '';
  }

  private mapTipToSide(tip: string): Side | null {
    const t = tip.toUpperCase().trim();
    if (t === '1' || t === 'H' || t === 'HOME' || t === 'HOME WIN' || t === '1X') return 'home';
    if (t === '2' || t === 'A' || t === 'AWAY' || t === 'AWAY WIN' || t === 'X2') return 'away';
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
      t === 'OV' || t === 'UN' || /^[OU]\d/.test(t);
  }

  private isBtts(tip: string): boolean {
    const t = tip.toUpperCase().trim();
    return t === 'GG' || t === 'NG' || t.startsWith('BTTS');
  }

  private parseTeamsString(text: string): { home: string; away: string } | null {
    const match = text.match(/^(.+?)\s+(?:vs?\.?|[-–])\s+(.+)$/i);
    if (match && match[1] && match[2]) {
      return { home: match[1].trim(), away: match[2].trim() };
    }
    return null;
  }

  private oddsToConfidence(odds: number): Confidence | null {
    if (odds <= 0) return null;
    const impliedProb = 1 / odds;
    if (impliedProb >= 0.75) return 'best_bet';
    if (impliedProb >= 0.55) return 'high';
    if (impliedProb >= 0.35) return 'medium';
    return 'low';
  }

  private normalizeDate(text: string, fetchedAt: Date): string {
    const today = fetchedAt.toISOString().split('T')[0]!;
    if (!text) return today;

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

    // DD/MM/YYYY or DD-MM-YYYY
    const match = text.match(/(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?/);
    if (match) {
      const day = match[1]!.padStart(2, '0');
      const month = match[2]!.padStart(2, '0');
      const year = match[3]
        ? (match[3].length === 2 ? `20${match[3]}` : match[3])
        : String(fetchedAt.getFullYear());
      return `${year}-${month}-${day}`;
    }

    return today;
  }

  private extractTime(text: string): string | null {
    if (!text) return null;
    const match = text.match(/(\d{1,2}:\d{2})/);
    return match ? match[1]! : null;
  }
}
