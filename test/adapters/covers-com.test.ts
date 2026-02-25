import { describe, it, expect } from 'vitest';
import { CoversComAdapter } from '../../src/adapters/covers-com.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('CoversComAdapter', () => {
  const adapter = new CoversComAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('covers-com');
    expect(adapter.config.fetchMethod).toBe('http');
    expect(adapter.config.baseUrl).toBe('https://www.covers.com');
    expect(adapter.config.paths.nba).toBe('/picks/nba');
  });

  describe('discoverUrls', () => {
    it('should extract article URLs from landing page', () => {
      const html = loadFixture('covers-com', 'nba-picks.html');
      const urls = adapter.discoverUrls!(html, 'nba');

      expect(urls).toBeInstanceOf(Array);
      expect(urls.length).toBeGreaterThan(0);
      urls.forEach((url) => {
        expect(url).toMatch(/^https:\/\/www\.covers\.com\//);
        expect(url).toMatch(/prediction|picks|best-bet|computer-picks/i);
      });
    });

    it('should extract Read Full Analysis links from picks cards', () => {
      const html = loadFixture('covers-com', 'nba-picks.html');
      const urls = adapter.discoverUrls!(html, 'nba');

      // Our fixture has 2 unique article URLs (wizards-vs-hawks and thunder-vs-raptors)
      expect(urls.length).toBe(2);
      expect(urls).toContain(
        'https://www.covers.com/nba/wizards-vs-hawks-prediction-picks-best-bets-sgp-tuesday-2-24-2026',
      );
      expect(urls).toContain(
        'https://www.covers.com/nba/thunder-vs-raptors-prediction-picks-best-bets-sgp-tuesday-2-24-2026',
      );
    });

    it('should deduplicate URLs', () => {
      const html = loadFixture('covers-com', 'nba-picks.html');
      const urls = adapter.discoverUrls!(html, 'nba');
      const unique = new Set(urls);
      expect(urls.length).toBe(unique.size);
    });

    it('should use generic link fallback when no picks-card elements found', () => {
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

  describe('parse (landing page)', () => {
    it('should parse expert picks from landing page picks-cards', () => {
      const html = loadFixture('covers-com', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-24'));

      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBeGreaterThan(0);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('covers-com');
        expect(p.sport).toBe('nba');
        expect(p.pickerName).toBeTruthy();
        expect(p.pickType).toBeTruthy();
      });
    });

    it('should extract teams from picks-card header', () => {
      const html = loadFixture('covers-com', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-24'));

      // Game 1 picks should have Wizards/Hawks teams
      const game1Picks = predictions.filter(
        (p) => p.homeTeamRaw === 'Atlanta Hawks',
      );
      expect(game1Picks.length).toBeGreaterThan(0);
      game1Picks.forEach((p) => {
        expect(p.awayTeamRaw).toBe('Washington Wizards');
        expect(p.homeTeamRaw).toBe('Atlanta Hawks');
      });
    });

    it('should parse over/under pick text with o/u prefix', () => {
      const html = loadFixture('covers-com', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-24'));

      // "Jalen Johnson o7.5 Total Assists (-145)" -> over_under, over, 7.5
      const assistsPick = predictions.find(
        (p) => p.pickType === 'over_under' && p.value === 7.5,
      );
      expect(assistsPick).toBeDefined();
      expect(assistsPick?.side).toBe('over');
      expect(assistsPick?.pickerName).toBe('Quinn Allen');
    });

    it('should parse prop pick text (double-double)', () => {
      const html = loadFixture('covers-com', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-24'));

      // "Scottie Barnes Record a Double-Double (Yes: +135)" -> prop
      const ddPick = predictions.find(
        (p) => p.pickType === 'prop' && p.homeTeamRaw === 'Toronto Raptors',
      );
      expect(ddPick).toBeDefined();
      expect(ddPick?.side).toBe('yes');
      expect(ddPick?.value).toBe(135);
      expect(ddPick?.pickerName).toBe('Andrew Caley');
    });

    it('should parse spread pick text', () => {
      const html = loadFixture('covers-com', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-24'));

      // "Thunder -11.5 (-110)" -> spread
      const spreadPick = predictions.find(
        (p) => p.pickType === 'spread' && p.value === -11.5,
      );
      expect(spreadPick).toBeDefined();
      expect(spreadPick?.pickerName).toBe('Mike Jones');
    });

    it('should extract game time from header', () => {
      const html = loadFixture('covers-com', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-24'));

      const withTime = predictions.find((p) => p.gameTime !== null);
      expect(withTime).toBeDefined();
      expect(withTime?.gameTime).toContain('7:30 PM ET');
    });

    it('should return empty array for empty HTML', () => {
      const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
      expect(predictions).toEqual([]);
    });
  });

  describe('parse (article page)', () => {
    it('should parse best bets from article fixture', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-24'));

      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBeGreaterThan(0);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('covers-com');
        expect(p.sport).toBe('nba');
        expect(p.pickerName).toBeTruthy();
        expect(p.pickType).toBeTruthy();
      });
    });

    it('should extract matchup from canonical URL', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-24'));

      // URL: /nba/wizards-vs-hawks-prediction-... -> away=Wizards, home=Hawks
      predictions.forEach((p) => {
        expect(p.awayTeamRaw).toBe('Wizards');
        expect(p.homeTeamRaw).toBe('Hawks');
      });
    });

    it('should extract best bet with Over prop', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-24'));

      // Best bet: "Jalen Johnson Over 7.5 assists (-145)" -> over_under, over, 7.5
      const bestBets = predictions.filter((p) => p.confidence === 'best_bet');
      expect(bestBets.length).toBe(1);

      const ouBet = bestBets[0]!;
      expect(ouBet.pickType).toBe('over_under');
      expect(ouBet.side).toBe('over');
      expect(ouBet.value).toBe(7.5);
      expect(ouBet.reasoning).toContain('Jalen Johnson Over 7.5 assists');
    });

    it('should extract structured odds from list items', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-24'));

      // Structured odds have confidence=null (not best bets)
      const structured = predictions.filter((p) => p.confidence === null);
      expect(structured.length).toBe(3);

      // Spread: Hawks -13.5 is the favorite -> side=home, value=-13.5
      const spread = structured.find((p) => p.pickType === 'spread');
      expect(spread?.side).toBe('home');
      expect(spread?.value).toBe(-13.5);

      // Moneyline: Hawks -850 -> side=home, value=-850
      const ml = structured.find((p) => p.pickType === 'moneyline');
      expect(ml?.side).toBe('home');
      expect(ml?.value).toBe(-850);

      // Over/Under: 236.5 -> side=over (default), value=236.5
      const ou = structured.find((p) => p.pickType === 'over_under');
      expect(ou?.side).toBe('over');
      expect(ou?.value).toBe(236.5);
    });

    it('should extract author name from authorName element', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-24'));

      if (predictions.length > 0) {
        expect(predictions[0]!.pickerName).toBe('Quinn Allen');
      }
    });

    it('should extract game date from article timestamp', () => {
      const html = loadFixture('covers-com', 'nba-article.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-24'));

      predictions.forEach((p) => {
        expect(p.gameDate).toBe('2026-02-24');
      });
    });

    it('should return empty array for empty HTML', () => {
      const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
      expect(predictions).toEqual([]);
    });
  });
});
