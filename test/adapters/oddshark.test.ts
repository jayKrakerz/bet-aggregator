import { describe, it, expect } from 'vitest';
import { OddSharkAdapter } from '../../src/adapters/oddshark.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('OddSharkAdapter', () => {
  const adapter = new OddSharkAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('oddshark');
    expect(adapter.config.fetchMethod).toBe('browser');
    expect(adapter.config.baseUrl).toBe('https://www.oddsshark.com');
    expect(adapter.config.paths.nba).toBe('/nba/computer-picks');
  });

  describe('parse (computer picks)', () => {
    it('should parse computer picks from real fixture', () => {
      const html = loadFixture('oddshark', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBeGreaterThan(0);

      // All predictions should have source ID
      predictions.forEach((p) => {
        expect(p.sourceId).toBe('oddshark');
        expect(p.sport).toBe('nba');
        expect(p.pickType).toBeTruthy();
      });

      // Computer picks should have team names
      const computerPicks = predictions.filter(
        (p) => p.pickerName === 'OddsShark Computer',
      );
      expect(computerPicks.length).toBeGreaterThan(0);

      computerPicks.forEach((p) => {
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
      });
    });

    it('should produce spread, moneyline, and total picks per game', () => {
      const html = loadFixture('oddshark', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const computerPicks = predictions.filter(
        (p) => p.pickerName === 'OddsShark Computer',
      );

      const spreadPicks = computerPicks.filter((p) => p.pickType === 'spread');
      const mlPicks = computerPicks.filter((p) => p.pickType === 'moneyline');
      const totalPicks = computerPicks.filter((p) => p.pickType === 'over_under');

      // Should have at least some of each type
      expect(spreadPicks.length).toBeGreaterThan(0);
      expect(mlPicks.length).toBeGreaterThan(0);
      expect(totalPicks.length).toBeGreaterThan(0);

      // Spread picks should have numeric values
      spreadPicks.forEach((p) => {
        expect(p.value).toEqual(expect.any(Number));
      });

      // Total picks should be over or under
      totalPicks.forEach((p) => {
        expect(['over', 'under']).toContain(p.side);
        expect(p.value).toEqual(expect.any(Number));
      });
    });

    it('should extract game dates from JSON-LD', () => {
      const html = loadFixture('oddshark', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const computerPicks = predictions.filter(
        (p) => p.pickerName === 'OddsShark Computer',
      );

      // At least some should have proper dates
      const withDates = computerPicks.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.gameDate));
      expect(withDates.length).toBeGreaterThan(0);
    });
  });

  describe('parse (expert picks)', () => {
    it('should parse expert prop bets', () => {
      const html = loadFixture('oddshark', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const expertPicks = predictions.filter(
        (p) => p.pickerName !== 'OddsShark Computer',
      );

      if (expertPicks.length > 0) {
        expertPicks.forEach((p) => {
          expect(p.pickerName).toBeTruthy();
          expect(p.reasoning).toBeTruthy();
          expect(p.pickType).toBe('prop');
        });
      }
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
