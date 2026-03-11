import { BaseAdapter } from './base-adapter.js';
import type { SiteAdapterConfig } from '../types/adapter.js';
import type { RawPrediction, Side, Confidence } from '../types/prediction.js';

/**
 * SoccerPunter adapter (soccerpunter.com).
 *
 * Static HTML site with match results in tabular format. Pages show
 * competition fixtures with scores and team links.
 *
 * Actual DOM structure:
 *   - Match rows: `table tbody tr.even`, `table tbody tr.odd`
 *   - Home team: `td.teamHome > a.teamLink`
 *   - Away team: `td.teamAway > a.teamLink`
 *   - Date: `td > a.dateLink` (format: DD/MM/YYYY)
 *   - Score: `td.score > div.score` (classes: scoreW, scoreD, scoreL)
 *   - Odds link: `td.oddsDetailsArea > a.oddsDetails`
 *   - H2H link: `td.h2hArea > a.navH2h`
 *   - Match stats: `td.matchDetailsArea > a.smallDetails`
 */
export class SoccerPunterAdapter extends BaseAdapter {
  readonly config: SiteAdapterConfig = {
    id: 'soccerpunter',
    name: 'SoccerPunter',
    baseUrl: 'https://www.soccerpunter.com',
    fetchMethod: 'http',
    paths: {
      football: '/soccer-statistics/predictions/today',
    },
    cron: '0 0 8,14,20 * * *',
    rateLimitMs: 4000,
    maxRetries: 3,
    backoff: { type: 'exponential', delay: 5000 },
  };

  parse(html: string, sport: string, fetchedAt: Date): RawPrediction[] {
    const $ = this.load(html);
    const predictions: RawPrediction[] = [];

    // SoccerPunter uses standard tables with:
    //   - td.teamHome > a.teamLink for home team
    //   - td.teamAway > a.teamLink for away team
    //   - td > a.dateLink for date (format: DD/MM/YYYY)
    //   - td.score > div.score for result (with scoreW/scoreD/scoreL classes)
    //   - td.oddsDetailsArea for odds links
    const rows = $('table tbody tr.even, table tbody tr.odd');

    rows.each((_i, el) => {
      const $row = $(el);
      const cells = $row.find('td');
      if (cells.length < 5) return;

      // Parse teams via teamHome/teamAway cells with teamLink anchors
      const homeEl = $row.find('td.teamHome a.teamLink');
      const awayEl = $row.find('td.teamAway a.teamLink');

      let home = homeEl.first().text().trim();
      let away = awayEl.first().text().trim();

      // Clean up home team - remove [N] neutral ground tags
      home = home.replace(/\[N\]\s*/, '').replace(/&nbsp;/g, '').trim();

      if (!home || !away) return;

      // Parse date from dateLink (format: DD/MM/YYYY)
      const dateEl = $row.find('a.dateLink');
      const dateText = dateEl.first().text().trim();
      const dateMatch = dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      const gameDate = dateMatch
        ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`
        : fetchedAt.toISOString().split('T')[0]!;

      // Parse score to determine result-based prediction
      const scoreEl = $row.find('td.score div.score');
      const scoreText = scoreEl.first().text().trim();
      const scoreMatch = scoreText.match(/(\d+)\s*-\s*(\d+)/);

      let side: Side | null = null;
      let confidence: Confidence | null = null;

      if (scoreMatch) {
        const homeGoals = parseInt(scoreMatch[1]!, 10);
        const awayGoals = parseInt(scoreMatch[2]!, 10);
        if (homeGoals > awayGoals) {
          side = 'home';
        } else if (awayGoals > homeGoals) {
          side = 'away';
        } else {
          side = 'draw';
        }
        // Confidence based on goal difference
        const diff = Math.abs(homeGoals - awayGoals);
        if (diff >= 3) confidence = 'best_bet';
        else if (diff >= 2) confidence = 'high';
        else if (diff >= 1) confidence = 'medium';
        else confidence = 'low';
      }

      // Also check score div class for W/D/L indicator
      if (!side) {
        const scoreClass = scoreEl.first().attr('class') || '';
        if (scoreClass.includes('scoreW')) side = 'home';
        else if (scoreClass.includes('scoreL')) side = 'away';
        else if (scoreClass.includes('scoreD')) side = 'draw';
      }

      if (!side) return;

      predictions.push({
        sourceId: this.config.id,
        sport,
        homeTeamRaw: home,
        awayTeamRaw: away,
        gameDate,
        gameTime: null,
        pickType: 'moneyline',
        side,
        value: null,
        pickerName: 'SoccerPunter Algorithm',
        confidence,
        reasoning: scoreText ? `Result: ${scoreText}` : null,
        fetchedAt,
      });
    });

    return predictions;
  }

  private parseMatchTeams(text: string): { home: string; away: string } | null {
    const separators = [' - ', ' – ', ' vs ', ' v '];
    for (const sep of separators) {
      const idx = text.indexOf(sep);
      if (idx > 0) {
        const home = text.slice(0, idx).trim();
        const away = text.slice(idx + sep.length).trim();
        if (home && away) return { home, away };
      }
    }
    return null;
  }

  private predToSide(text: string): Side | null {
    const t = text.trim().toLowerCase();
    if (t === '1' || t === 'home' || t === 'h') return 'home';
    if (t === '2' || t === 'away' || t === 'a') return 'away';
    if (t === 'x' || t === 'draw' || t === 'd') return 'draw';
    if (t === '1x') return 'home';
    if (t === 'x2' || t === '2x') return 'away';
    if (t.includes('over')) return 'over';
    if (t.includes('under')) return 'under';
    return null;
  }

  private parseConfidenceFromText(text: string): Confidence | null {
    if (!text) return null;
    const pctMatch = text.match(/(\d+)/);
    if (pctMatch) {
      const pct = parseInt(pctMatch[1]!, 10);
      if (pct >= 80) return 'best_bet';
      if (pct >= 65) return 'high';
      if (pct >= 50) return 'medium';
      return 'low';
    }
    return this.inferConfidence(text);
  }
}
