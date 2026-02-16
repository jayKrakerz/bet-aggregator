import { describe, it, expect } from 'vitest';
import { BettingProsAdapter } from '../../src/adapters/bettingpros.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('BettingProsAdapter', () => {
  const adapter = new BettingProsAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('bettingpros');
    expect(adapter.config.fetchMethod).toBe('browser');
    expect(adapter.config.baseUrl).toBe('https://www.bettingpros.com');
    expect(adapter.config.paths.nba).toBe('/nba/picks/');
    expect(adapter.config.paths.ncaab).toBe('/college-basketball/picks/');
  });

  describe('parse (NBA consensus picks)', () => {
    it('should parse predictions from consensus table', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      // 2 games × 3 pick types = 6
      expect(predictions.length).toBe(6);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('bettingpros');
        expect(p.sport).toBe('nba');
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(p.pickerName).toBe('BettingPros Consensus');
        expect(['spread', 'moneyline', 'over_under']).toContain(p.pickType);
      });
    });

    it('should extract spread picks with consensus direction', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const spreads = predictions.filter((p) => p.pickType === 'spread');
      expect(spreads.length).toBe(2);

      // BOS vs LAL: 72% on away (BOS)
      const lalGame = spreads.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.side).toBe('away');
      expect(lalGame?.value).toBe(-6.5);
      expect(lalGame?.reasoning).toContain('72%');

      // MIL vs GSW: 54% on home (GSW)
      const gswGame = spreads.find((p) => p.homeTeamRaw === 'Golden State Warriors');
      expect(gswGame?.side).toBe('home');
      expect(gswGame?.value).toBe(2.0);
    });

    it('should extract moneyline picks with win probabilities', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const mls = predictions.filter((p) => p.pickType === 'moneyline');
      expect(mls.length).toBe(2);

      // BOS vs LAL: 88% consensus on BOS ML
      const lalGame = mls.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.side).toBe('away');
      expect(lalGame?.value).toBe(-280);
      expect(lalGame?.reasoning).toContain('88%');
      expect(lalGame?.reasoning).toContain('78.2%');
    });

    it('should extract over/under picks', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const totals = predictions.filter((p) => p.pickType === 'over_under');
      expect(totals.length).toBe(2);

      // BOS vs LAL: Over 57%
      const lalGame = totals.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.side).toBe('over');
      expect(lalGame?.value).toBe(221.5);

      // MIL vs GSW: Under 63%
      const gswGame = totals.find((p) => p.homeTeamRaw === 'Golden State Warriors');
      expect(gswGame?.side).toBe('under');
      expect(gswGame?.value).toBe(233.0);
    });

    it('should include expert count in reasoning', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const lalSpread = predictions.find(
        (p) => p.homeTeamRaw === 'Los Angeles Lakers' && p.pickType === 'spread',
      );
      expect(lalSpread?.reasoning).toContain('112 of 156 experts');
    });

    it('should map model probabilities to confidence', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      // BOS ML prob 78.2% → best_bet
      const lalMl = predictions.find(
        (p) => p.homeTeamRaw === 'Los Angeles Lakers' && p.pickType === 'moneyline',
      );
      expect(lalMl?.confidence).toBe('best_bet');

      // GSW spread prob 51.2% → low
      const gswSpread = predictions.find(
        (p) => p.homeTeamRaw === 'Golden State Warriors' && p.pickType === 'spread',
      );
      expect(gswSpread?.confidence).toBe('low');
    });

    it('should use data-date attribute for game date', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toBe('2026-02-16');
      });
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array for page with no picks rows', () => {
    const html = '<html><body><div id="app"><table class="picks-table"><tbody></tbody></table></div></body></html>';
    const predictions = adapter.parse(html, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
