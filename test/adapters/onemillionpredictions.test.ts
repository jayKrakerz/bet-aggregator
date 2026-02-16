import { describe, it, expect } from 'vitest';
import { OneMillionPredictionsAdapter } from '../../src/adapters/onemillionpredictions.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('OneMillionPredictionsAdapter', () => {
  const adapter = new OneMillionPredictionsAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('onemillionpredictions');
    expect(adapter.config.fetchMethod).toBe('browser');
    expect(adapter.config.baseUrl).toBe('https://onemillionpredictions.com');
    expect(adapter.config.paths.football).toBe('/');
  });

  describe('parse (BTTS page)', () => {
    it('should parse BTTS predictions from real fixture', () => {
      const html = loadFixture('onemillionpredictions', 'btts.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBeGreaterThan(0);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('onemillionpredictions');
        expect(p.sport).toBe('football');
        expect(p.pickType).toBe('prop');
        expect(['yes', 'no']).toContain(p.side);
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(p.pickerName).toBe('OneMillionPredictions');
      });
    });

    it('should extract game dates in YYYY-MM-DD format', () => {
      const html = loadFixture('onemillionpredictions', 'btts.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      const withDates = predictions.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.gameDate));
      expect(withDates.length).toBe(predictions.length);
    });

    it('should extract game times', () => {
      const html = loadFixture('onemillionpredictions', 'btts.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      const withTimes = predictions.filter((p) => p.gameTime && /^\d{1,2}:\d{2}$/.test(p.gameTime));
      expect(withTimes.length).toBeGreaterThan(0);
    });

    it('should have odds values for most predictions', () => {
      const html = loadFixture('onemillionpredictions', 'btts.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      const withOdds = predictions.filter((p) => p.value !== null && p.value > 0);
      // Most predictions have odds, but some rows on the site lack odds data
      expect(withOdds.length).toBeGreaterThan(predictions.length * 0.8);
    });

    it('should store league info in reasoning', () => {
      const html = loadFixture('onemillionpredictions', 'btts.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      const withLeague = predictions.filter((p) => p.reasoning && p.reasoning.length > 0);
      expect(withLeague.length).toBeGreaterThan(0);
    });
  });

  describe('parse (1X2 page)', () => {
    it('should parse 1X2 predictions from real fixture', () => {
      const html = loadFixture('onemillionpredictions', '1x2.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBeGreaterThan(0);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('onemillionpredictions');
        expect(p.sport).toBe('football');
        expect(p.pickType).toBe('moneyline');
        expect(['home', 'draw', 'away']).toContain(p.side);
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
      });
    });

    it('should produce all three 1X2 sides', () => {
      const html = loadFixture('onemillionpredictions', '1x2.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      const sides = new Set(predictions.map((p) => p.side));
      expect(sides).toContain('home');
      expect(sides).toContain('draw');
      expect(sides).toContain('away');
    });

    it('should detect page type as 1x2 from title', () => {
      const html = loadFixture('onemillionpredictions', '1x2.html');
      const predictions = adapter.parse(html, 'football', new Date('2026-02-16'));

      // All predictions should be moneyline (1X2 page)
      predictions.forEach((p) => {
        expect(p.pickType).toBe('moneyline');
      });
    });
  });

  describe('discoverUrls', () => {
    it('should discover sub-page URLs from navigation table', () => {
      const html = loadFixture('onemillionpredictions', 'btts.html');
      const urls = adapter.discoverUrls(html, 'football');

      expect(urls).toBeInstanceOf(Array);
      expect(urls.length).toBeGreaterThan(0);

      // Should include known prediction type pages
      const urlPaths = urls.map((u) => new URL(u).pathname);
      expect(urlPaths).toEqual(
        expect.arrayContaining([
          expect.stringContaining('goals'),
        ]),
      );

      // Should not include premium
      urls.forEach((u) => {
        expect(u.toLowerCase()).not.toContain('premium');
      });
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'football', new Date());
    expect(predictions).toEqual([]);
  });
});
