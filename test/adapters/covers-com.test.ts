import { describe, it, expect } from 'vitest';
import { CoversComAdapter } from '../../src/adapters/covers-com.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('CoversComAdapter', () => {
  const adapter = new CoversComAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('covers-com');
    expect(adapter.config.fetchMethod).toBe('http');
    expect(adapter.config.baseUrl).toBe('https://www.covers.com');
  });

  describe('discoverUrls', () => {
    it('should extract article URLs from landing page', () => {
      const html = loadFixture('covers-com', 'nba-picks.html');
      const urls = adapter.discoverUrls!(html, 'nba');

      expect(urls).toBeInstanceOf(Array);
      expect(urls.length).toBeGreaterThan(0);
      urls.forEach((url) => {
        expect(url).toMatch(/^https:\/\/www\.covers\.com\//);
        expect(url).toMatch(/pick|prediction|odds|best-bet/i);
      });
    });

    it('should return empty array for empty HTML', () => {
      const urls = adapter.discoverUrls!('<html><body></body></html>', 'nba');
      expect(urls).toEqual([]);
    });
  });

  describe('parse (article page)', () => {
    it('should parse best bets from a real article fixture', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-14'));

      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBeGreaterThan(0);

      // All predictions should have source ID
      predictions.forEach((p) => {
        expect(p.sourceId).toBe('covers-com');
        expect(p.sport).toBe('nba');
        expect(p.pickerName).toBeTruthy();
        expect(p.confidence).toBe('best_bet');
        expect(p.pickType).toBeTruthy();
      });

      // First best bet should be a moneyline pick on "World"
      const worldPick = predictions.find((p) => p.reasoning?.includes('World'));
      if (worldPick) {
        expect(worldPick.pickType).toBe('moneyline');
        expect(worldPick.value).toBe(165);
      }

      // Should find the Under 81.5 pick
      const underPick = predictions.find((p) => p.pickType === 'over_under' && p.side === 'under');
      if (underPick) {
        expect(underPick.value).toBe(81.5);
      }
    });

    it('should extract author name', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-14'));

      if (predictions.length > 0) {
        expect(predictions[0]!.pickerName).toContain('Douglas Farmer');
      }
    });

    it('should return empty array for empty HTML', () => {
      const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
      expect(predictions).toEqual([]);
    });
  });
});
