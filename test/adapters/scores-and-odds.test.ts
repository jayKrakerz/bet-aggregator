import { describe, it, expect } from 'vitest';
import { ScoresAndOddsAdapter } from '../../src/adapters/scores-and-odds.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('ScoresAndOddsAdapter', () => {
  const adapter = new ScoresAndOddsAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('scores-and-odds');
    expect(adapter.config.fetchMethod).toBe('http');
    expect(adapter.config.baseUrl).toBe('https://www.scoresandodds.com');
    expect(adapter.config.paths.nba).toBe('/nba/consensus-picks');
    expect(adapter.config.paths.nfl).toBe('/nfl/consensus-picks');
    expect(adapter.config.paths.ncaab).toBe('/ncaab/consensus-picks');
  });

  describe('parse (NBA consensus)', () => {
    it('should parse predictions from consensus table', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      // 2 games × 3 pick types = 6
      expect(predictions.length).toBe(6);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('scores-and-odds');
        expect(p.sport).toBe('nba');
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(p.pickerName).toBe('ScoresAndOdds Consensus');
        expect(['spread', 'moneyline', 'over_under']).toContain(p.pickType);
      });
    });

    it('should extract spread picks with consensus percentages', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const spreads = predictions.filter((p) => p.pickType === 'spread');
      expect(spreads.length).toBe(2);

      // BOS vs LAL: 68% on away (BOS) → away
      const lalGame = spreads.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.side).toBe('away');
      expect(lalGame?.value).toBe(-6.5);
      expect(lalGame?.reasoning).toContain('68%');
    });

    it('should extract moneyline picks with consensus sides', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const mls = predictions.filter((p) => p.pickType === 'moneyline');
      expect(mls.length).toBe(2);

      // BOS vs LAL: 75% on away ML → away
      const lalGame = mls.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.side).toBe('away');
      expect(lalGame?.value).toBe(-280);
      expect(lalGame?.reasoning).toContain('75%');
    });

    it('should extract over/under picks', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const totals = predictions.filter((p) => p.pickType === 'over_under');
      expect(totals.length).toBe(2);

      // BOS vs LAL: 58% over → over
      const lalGame = totals.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.side).toBe('over');
      expect(lalGame?.value).toBe(221.5);

      // MIL vs GSW: 56% under → under
      const gswGame = totals.find((p) => p.homeTeamRaw === 'Golden State Warriors');
      expect(gswGame?.side).toBe('under');
      expect(gswGame?.value).toBe(233.0);
    });

    it('should map consensus percentages to confidence', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      // 75% → best_bet
      const lalMl = predictions.find(
        (p) => p.homeTeamRaw === 'Los Angeles Lakers' && p.pickType === 'moneyline',
      );
      expect(lalMl?.confidence).toBe('best_bet');

      // 51% → low
      const gswMl = predictions.find(
        (p) => p.homeTeamRaw === 'Golden State Warriors' && p.pickType === 'moneyline',
      );
      expect(gswMl?.confidence).toBe('low');
    });

    it('should extract game date from page header', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toBe('2026-02-16');
      });
    });

    it('should extract game times', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const lalGame = predictions.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.gameTime).toBe('7:30 PM ET');

      const gswGame = predictions.find((p) => p.homeTeamRaw === 'Golden State Warriors');
      expect(gswGame?.gameTime).toBe('10:00 PM ET');
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array for table with no event rows', () => {
    const html = '<html><body><table class="event-table"><tbody></tbody></table></body></html>';
    const predictions = adapter.parse(html, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
