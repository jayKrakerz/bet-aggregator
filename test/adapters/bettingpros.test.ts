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
    it('should parse predictions from game cards', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      // 2 games x 3 pick types (moneyline, spread, over_under) = 6
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

    it('should extract team names from side--left and side--right', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const lalGame = predictions.find(
        (p) => p.homeTeamRaw === 'Los Angeles Lakers' && p.pickType === 'moneyline',
      );
      expect(lalGame?.awayTeamRaw).toBe('Boston Celtics');
      expect(lalGame?.homeTeamRaw).toBe('Los Angeles Lakers');
    });

    it('should extract moneyline picks with consensus direction', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const mls = predictions.filter((p) => p.pickType === 'moneyline');
      expect(mls.length).toBe(2);

      // BOS 77% vs LAL 23% -> away wins consensus
      const lalGame = mls.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.side).toBe('away');
      expect(lalGame?.value).toBe(-280);
      expect(lalGame?.reasoning).toContain('77%');
      expect(lalGame?.reasoning).toContain('23%');

      // MIL 46% vs GSW 54% -> home wins consensus
      const gswGame = mls.find((p) => p.homeTeamRaw === 'Golden State Warriors');
      expect(gswGame?.side).toBe('home');
      expect(gswGame?.value).toBe(115);
    });

    it('should extract spread picks with consensus direction', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const spreads = predictions.filter((p) => p.pickType === 'spread');
      expect(spreads.length).toBe(2);

      // BOS 77% vs LAL 23% -> away consensus -> away spread=-6.5
      const lalGame = spreads.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.side).toBe('away');
      expect(lalGame?.value).toBe(-6.5);
      expect(lalGame?.reasoning).toContain('77%');

      // MIL 46% vs GSW 54% -> home consensus -> home spread=+2.0
      const gswGame = spreads.find((p) => p.homeTeamRaw === 'Golden State Warriors');
      expect(gswGame?.side).toBe('home');
      expect(gswGame?.value).toBe(2.0);
    });

    it('should extract over/under picks', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const totals = predictions.filter((p) => p.pickType === 'over_under');
      expect(totals.length).toBe(2);

      // BOS @ LAL: total = 221.5
      const lalGame = totals.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.side).toBe('over');
      expect(lalGame?.value).toBe(221.5);

      // MIL @ GSW: total = 233.0
      const gswGame = totals.find((p) => p.homeTeamRaw === 'Golden State Warriors');
      expect(gswGame?.side).toBe('over');
      expect(gswGame?.value).toBe(233.0);
    });

    it('should map consensus percentages to confidence', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      // BOS 77% -> best_bet (>= 75)
      const lalMl = predictions.find(
        (p) => p.homeTeamRaw === 'Los Angeles Lakers' && p.pickType === 'moneyline',
      );
      expect(lalMl?.confidence).toBe('best_bet');

      // GSW 54% -> low (< 55)
      const gswMl = predictions.find(
        (p) => p.homeTeamRaw === 'Golden State Warriors' && p.pickType === 'moneyline',
      );
      expect(gswMl?.confidence).toBe('low');
    });

    it('should use fetchedAt date for gameDate', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toBe('2026-02-16');
      });
    });

    it('should set gameTime to null (no time in card)', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameTime).toBeNull();
      });
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array for page with no game cards', () => {
    const html = '<html><body><div id="app"><div class="game-picks-module"></div></div></body></html>';
    const predictions = adapter.parse(html, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
