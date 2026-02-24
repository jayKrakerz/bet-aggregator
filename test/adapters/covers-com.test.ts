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

    it('should use generic link fallback when no article elements found', () => {
      const html = `<html><body>
        <a href="/nba/jazz-vs-rockets-prediction-picks-02-14">Jazz vs Rockets</a>
        <a href="/nba/celtics-vs-lakers-prediction-picks-02-14">Celtics vs Lakers</a>
        <a href="/nba/standings">Standings</a>
      </body></html>`;
      const urls = adapter.discoverUrls!(html, 'nba');

      expect(urls.length).toBe(2);
      urls.forEach((url) => {
        expect(url).toMatch(/prediction/);
      });
    });

    it('should return empty array for empty HTML', () => {
      const urls = adapter.discoverUrls!('<html><body></body></html>', 'nba');
      expect(urls).toEqual([]);
    });
  });

  describe('parse (article page)', () => {
    it('should parse best bets from article fixture', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-14'));

      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBeGreaterThan(0);

      // All predictions should have source ID
      predictions.forEach((p) => {
        expect(p.sourceId).toBe('covers-com');
        expect(p.sport).toBe('nba');
        expect(p.pickerName).toBeTruthy();
        expect(p.pickType).toBeTruthy();
      });
    });

    it('should extract matchup from canonical URL', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-14'));

      // URL: /nba/jazz-vs-rockets-prediction-... -> away=Jazz, home=Rockets
      predictions.forEach((p) => {
        expect(p.awayTeamRaw).toBe('Jazz');
        expect(p.homeTeamRaw).toBe('Rockets');
      });
    });

    it('should extract best bet text AFTER the strong tag', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-14'));

      // Best bets should have confidence=best_bet
      const bestBets = predictions.filter((p) => p.confidence === 'best_bet');
      expect(bestBets.length).toBe(2);

      // First best bet: "Rockets -13 (-110)" -> spread, value=-13
      const spreadBet = bestBets.find((p) => p.pickType === 'spread');
      expect(spreadBet).toBeDefined();
      expect(spreadBet?.value).toBe(-13);
      expect(spreadBet?.reasoning).toContain('Rockets -13');

      // Second best bet: "Under 220.5 (-115)" -> over_under, side=under
      const ouBet = bestBets.find((p) => p.pickType === 'over_under');
      expect(ouBet).toBeDefined();
      expect(ouBet?.side).toBe('under');
      expect(ouBet?.value).toBe(220.5);
    });

    it('should extract structured odds from list items', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-14'));

      // Structured odds have confidence=null (not best bets)
      const structured = predictions.filter((p) => p.confidence === null);
      expect(structured.length).toBe(3);

      // Spread: Rockets -13 is the favorite -> side=home, value=-13
      const spread = structured.find((p) => p.pickType === 'spread');
      expect(spread?.side).toBe('home');
      expect(spread?.value).toBe(-13);

      // Moneyline: Rockets -850 -> side=home, value=-850
      const ml = structured.find((p) => p.pickType === 'moneyline');
      expect(ml?.side).toBe('home');
      expect(ml?.value).toBe(-850);

      // Over/Under: 220.5 -> side=over (default), value=220.5
      const ou = structured.find((p) => p.pickType === 'over_under');
      expect(ou?.side).toBe('over');
      expect(ou?.value).toBe(220.5);
    });

    it('should extract author name from authorName element', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-14'));

      if (predictions.length > 0) {
        expect(predictions[0]!.pickerName).toContain('Douglas Farmer');
      }
    });

    it('should extract game date from article metadata', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-14'));

      predictions.forEach((p) => {
        expect(p.gameDate).toBe('2026-02-14');
      });
    });

    it('should return empty array for empty HTML', () => {
      const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
      expect(predictions).toEqual([]);
    });
  });
});
