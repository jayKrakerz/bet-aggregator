import { describe, it, expect } from 'vitest';
import { PickswiseAdapter } from '../../src/adapters/pickswise.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('PickswiseAdapter', () => {
  const adapter = new PickswiseAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('pickswise');
    expect(adapter.config.fetchMethod).toBe('http');
    expect(adapter.config.baseUrl).toBe('https://www.pickswise.com');
    expect(adapter.config.paths.nba).toBe('/nba/picks/');
  });

  describe('parse (__NEXT_DATA__)', () => {
    // NOTE: The fixture is a real NCAAB page since NBA was on All-Star break
    // at scrape time. The __NEXT_DATA__ structure is identical for all sports.
    it('should parse picks from real __NEXT_DATA__ fixture', () => {
      const html = loadFixture('pickswise', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBeGreaterThan(0);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('pickswise');
        expect(p.sport).toBe('nba');
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(p.pickType).toBeTruthy();
        expect(p.pickerName).toBeTruthy();
      });
    });

    it('should extract spread picks with correct line values', () => {
      const html = loadFixture('pickswise', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const spreadPicks = predictions.filter((p) => p.pickType === 'spread');
      if (spreadPicks.length > 0) {
        spreadPicks.forEach((p) => {
          expect(p.value).toEqual(expect.any(Number));
          expect(['home', 'away']).toContain(p.side);
        });
      }
    });

    it('should extract moneyline picks with odds', () => {
      const html = loadFixture('pickswise', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const mlPicks = predictions.filter((p) => p.pickType === 'moneyline');
      if (mlPicks.length > 0) {
        mlPicks.forEach((p) => {
          expect(p.value).toEqual(expect.any(Number));
          expect(['home', 'away']).toContain(p.side);
        });
      }
    });

    it('should extract game dates', () => {
      const html = loadFixture('pickswise', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    });

    it('should extract picker names from tipsters', () => {
      const html = loadFixture('pickswise', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.pickerName).not.toBe('Pickswise Expert');
        expect(p.pickerName.length).toBeGreaterThan(0);
      });
    });

    it('should extract and clean reasoning text', () => {
      const html = loadFixture('pickswise', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const withReasoning = predictions.filter((p) => p.reasoning);
      expect(withReasoning.length).toBeGreaterThan(0);

      withReasoning.forEach((p) => {
        // Should not contain HTML tags
        expect(p.reasoning).not.toMatch(/<[^>]+>/);
        expect(p.reasoning!.length).toBeGreaterThan(0);
        expect(p.reasoning!.length).toBeLessThanOrEqual(500);
      });
    });

    it('should map confidence levels', () => {
      const html = loadFixture('pickswise', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        if (p.confidence) {
          expect(['low', 'medium', 'high', 'best_bet']).toContain(p.confidence);
        }
      });
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array when no picks are available', () => {
    // Simulates the All-Star break scenario with empty picks array
    const html = `<html><body>
      <script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"initialState":{"sportPredictionsPicks":{"/nba/picks/":[]}}}}}
      </script>
    </body></html>`;
    const predictions = adapter.parse(html, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
