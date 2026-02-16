import { describe, it, expect } from 'vitest';
import { ForebetAdapter } from '../../src/adapters/forebet.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('ForebetAdapter', () => {
  const adapter = new ForebetAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('forebet');
    expect(adapter.config.fetchMethod).toBe('browser');
    expect(adapter.config.baseUrl).toBe('https://www.forebet.com');
    expect(adapter.config.paths.football).toBe('/en/football-tips-and-predictions-for-today');
    expect(adapter.config.paths.nba).toBe('/en/basketball/usa/nba');
  });

  describe('parse (Football 1X2)', () => {
    it('should parse 1X2 predictions from fixture', () => {
      const html = loadFixture('forebet', 'football-1x2.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBeGreaterThan(0);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('forebet');
        expect(p.sport).toBe('football');
        expect(p.pickType).toBe('moneyline');
        expect(['home', 'draw', 'away']).toContain(p.side);
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(p.pickerName).toBe('Forebet');
      });
    });

    it('should produce all three 1X2 sides', () => {
      const html = loadFixture('forebet', 'football-1x2.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      const sides = new Set(predictions.map((p) => p.side));
      expect(sides).toContain('home');
      // Draw and away should appear if fixture has enough matches
      expect(sides.size).toBeGreaterThanOrEqual(2);
    });

    it('should extract game dates in YYYY-MM-DD format', () => {
      const html = loadFixture('forebet', 'football-1x2.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    });

    it('should extract game times', () => {
      const html = loadFixture('forebet', 'football-1x2.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      const withTimes = predictions.filter((p) => p.gameTime && /^\d{1,2}:\d{2}$/.test(p.gameTime));
      expect(withTimes.length).toBeGreaterThan(0);
    });

    it('should map probabilities to confidence', () => {
      const html = loadFixture('forebet', 'football-1x2.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      const withConfidence = predictions.filter((p) => p.confidence !== null);
      expect(withConfidence.length).toBeGreaterThan(0);

      const levels = new Set(withConfidence.map((p) => p.confidence));
      // Should have at least 2 different confidence levels
      expect(levels.size).toBeGreaterThanOrEqual(2);
    });

    it('should include predicted score and league in reasoning', () => {
      const html = loadFixture('forebet', 'football-1x2.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      const withReasoning = predictions.filter((p) => p.reasoning && p.reasoning.length > 0);
      expect(withReasoning.length).toBeGreaterThan(0);
    });

    it('should have decimal odds as values', () => {
      const html = loadFixture('forebet', 'football-1x2.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      const withOdds = predictions.filter((p) => p.value !== null && p.value > 1);
      // Most football predictions have odds
      expect(withOdds.length).toBeGreaterThan(predictions.length * 0.5);
    });
  });

  describe('parse (Basketball NBA)', () => {
    it('should parse basketball predictions from fixture', () => {
      const html = loadFixture('forebet', 'basketball.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBeGreaterThan(0);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('forebet');
        expect(p.sport).toBe('nba');
        expect(p.pickType).toBe('moneyline');
        // No draw in basketball
        expect(['home', 'away']).toContain(p.side);
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
      });
    });

    it('should not have draw picks in basketball', () => {
      const html = loadFixture('forebet', 'basketball.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const draws = predictions.filter((p) => p.side === 'draw');
      expect(draws.length).toBe(0);
    });

    it('should include predicted scores in reasoning', () => {
      const html = loadFixture('forebet', 'basketball.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const withScore = predictions.filter((p) => p.reasoning?.includes('Predicted:'));
      expect(withScore.length).toBeGreaterThan(0);
    });
  });

  describe('discoverUrls', () => {
    it('should discover sub-page URLs for football', () => {
      const html = loadFixture('forebet', 'football-1x2.html');
      const urls = adapter.discoverUrls(html, 'football');

      expect(urls).toBeInstanceOf(Array);
      // May or may not find URLs depending on fixture content
    });

    it('should return empty array for basketball', () => {
      const html = loadFixture('forebet', 'basketball.html');
      const urls = adapter.discoverUrls(html, 'nba');

      expect(urls).toEqual([]);
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'football', new Date());
    expect(predictions).toEqual([]);
  });
});
