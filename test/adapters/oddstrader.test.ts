import { describe, it, expect } from 'vitest';
import { OddsTraderAdapter } from '../../src/adapters/oddstrader.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('OddsTraderAdapter', () => {
  const adapter = new OddsTraderAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('oddstrader');
    expect(adapter.config.fetchMethod).toBe('browser');
    expect(adapter.config.baseUrl).toBe('https://www.oddstrader.com');
    expect(adapter.config.paths.nba).toBe('/nba/picks/');
    expect(adapter.config.paths.nfl).toBe('/nfl/picks/');
  });

  describe('parse (NCAA Basketball picks)', () => {
    // The fixture is from /today/picks/ with NCAAB games (lid=14)
    // We parse it as "nba" sport but the adapter scans all available lids
    it('should parse predictions from __INITIAL_STATE__', () => {
      const html = loadFixture('oddstrader', 'nba-picks.html');
      // Parse as ncaab since fixture has lid=14 data
      const predictions = adapter.parse(html, 'ncaab', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBeGreaterThan(0);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('oddstrader');
        expect(p.sport).toBe('ncaab');
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(p.pickerName).toBe('OddsTrader AI');
        expect(['spread', 'moneyline', 'over_under']).toContain(p.pickType);
      });
    });

    it('should extract spread picks with numeric values', () => {
      const html = loadFixture('oddstrader', 'nba-picks.html');
      const predictions = adapter.parse(html, 'ncaab', new Date('2026-02-16'));

      const spreads = predictions.filter((p) => p.pickType === 'spread');
      expect(spreads.length).toBeGreaterThan(0);

      spreads.forEach((p) => {
        expect(p.value).not.toBeNull();
        expect(typeof p.value).toBe('number');
        expect(['home', 'away']).toContain(p.side);
      });
    });

    it('should extract over/under picks with total values', () => {
      const html = loadFixture('oddstrader', 'nba-picks.html');
      const predictions = adapter.parse(html, 'ncaab', new Date('2026-02-16'));

      const totals = predictions.filter((p) => p.pickType === 'over_under');
      expect(totals.length).toBeGreaterThan(0);

      totals.forEach((p) => {
        expect(p.value).not.toBeNull();
        expect(p.value).toBeGreaterThan(50); // Basketball totals are high
        expect(['over', 'under']).toContain(p.side);
      });
    });

    it('should extract moneyline picks from consensus', () => {
      const html = loadFixture('oddstrader', 'nba-picks.html');
      const predictions = adapter.parse(html, 'ncaab', new Date('2026-02-16'));

      const mls = predictions.filter((p) => p.pickType === 'moneyline');
      expect(mls.length).toBeGreaterThan(0);

      mls.forEach((p) => {
        expect(['home', 'away']).toContain(p.side);
        expect(p.reasoning).toContain('consensus');
      });
    });

    it('should include predicted scores in reasoning', () => {
      const html = loadFixture('oddstrader', 'nba-picks.html');
      const predictions = adapter.parse(html, 'ncaab', new Date('2026-02-16'));

      const withReasoning = predictions.filter((p) => p.reasoning?.includes('Predicted:'));
      expect(withReasoning.length).toBeGreaterThan(0);
    });

    it('should map rank to confidence', () => {
      const html = loadFixture('oddstrader', 'nba-picks.html');
      const predictions = adapter.parse(html, 'ncaab', new Date('2026-02-16'));

      const withConfidence = predictions.filter((p) => p.confidence !== null);
      // Some picks have rank (e.g. rank=4 or rank=5)
      expect(withConfidence.length).toBeGreaterThan(0);

      const confidenceLevels = new Set(withConfidence.map((p) => p.confidence));
      // Should have high (rank=4) and/or best_bet (rank=5)
      expect(
        confidenceLevels.has('high') || confidenceLevels.has('best_bet'),
      ).toBe(true);
    });

    it('should extract game dates in YYYY-MM-DD format', () => {
      const html = loadFixture('oddstrader', 'nba-picks.html');
      const predictions = adapter.parse(html, 'ncaab', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    });
  });

  it('should return empty array for HTML without __INITIAL_STATE__', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array for malformed JSON', () => {
    const html = '<html><script>window.__INITIAL_STATE__ = {invalid json};</script></html>';
    const predictions = adapter.parse(html, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
