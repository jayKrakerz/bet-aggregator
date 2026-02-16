import { describe, it, expect } from 'vitest';
import { DimersAdapter } from '../../src/adapters/dimers.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('DimersAdapter', () => {
  const adapter = new DimersAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('dimers');
    expect(adapter.config.fetchMethod).toBe('browser');
    expect(adapter.config.baseUrl).toBe('https://www.dimers.com');
    expect(adapter.config.paths.nba).toBe('/bet-hub/nba/schedule');
    expect(adapter.config.paths.nfl).toBe('/bet-hub/nfl/schedule');
  });

  describe('parse (NBA schedule)', () => {
    it('should parse predictions from game cards', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      // Game 1: 3 edge rows (spread, total, ML) = 3
      // Game 2: 2 edge rows (spread, ML — total is push/skipped) = 2
      // Game 3: Final — skipped entirely
      expect(predictions.length).toBe(5);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('dimers');
        expect(p.sport).toBe('nba');
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(p.pickerName).toBe('Dimers Model');
        expect(['spread', 'moneyline', 'over_under']).toContain(p.pickType);
      });
    });

    it('should skip games with Final status', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const phxPicks = predictions.filter((p) =>
        p.homeTeamRaw === 'Denver Nuggets' || p.awayTeamRaw === 'Phoenix Suns',
      );
      expect(phxPicks.length).toBe(0);
    });

    it('should skip push edge rows (no direction)', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      // MIL vs GSW total edge is push → no O/U pick for that game
      const gswTotals = predictions.filter(
        (p) => p.homeTeamRaw === 'Golden State Warriors' && p.pickType === 'over_under',
      );
      expect(gswTotals.length).toBe(0);
    });

    it('should extract spread picks with edge-based confidence', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const spreads = predictions.filter((p) => p.pickType === 'spread');
      expect(spreads.length).toBe(2);

      // BOS @ LAL: edge +1.5 → medium confidence
      const lalSpread = spreads.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalSpread?.side).toBe('away');
      expect(lalSpread?.value).toBe(-6.5);
      expect(lalSpread?.confidence).toBe('medium');
      expect(lalSpread?.reasoning).toContain('Edge: +1.5');

      // MIL @ GSW: edge +1.0 → medium
      const gswSpread = spreads.find((p) => p.homeTeamRaw === 'Golden State Warriors');
      expect(gswSpread?.side).toBe('away');
      expect(gswSpread?.value).toBe(-2.0);
    });

    it('should extract over/under picks with predicted totals', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const totals = predictions.filter((p) => p.pickType === 'over_under');
      expect(totals.length).toBe(1);

      // BOS @ LAL: Under 221.5, edge -5.5 → best_bet
      const lalTotal = totals[0]!;
      expect(lalTotal.side).toBe('under');
      expect(lalTotal.value).toBe(221.5);
      expect(lalTotal.confidence).toBe('best_bet');
      expect(lalTotal.reasoning).toContain('Predicted total: 216');
    });

    it('should extract moneyline picks with win probability', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const mls = predictions.filter((p) => p.pickType === 'moneyline');
      expect(mls.length).toBe(2);

      // BOS @ LAL: BOS away, win prob 73%
      const lalMl = mls.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalMl?.side).toBe('away');
      expect(lalMl?.value).toBe(-280);
      expect(lalMl?.reasoning).toContain('Win prob: 73%');
    });

    it('should include predicted scores in reasoning', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const lalPick = predictions.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalPick?.reasoning).toContain('Predicted: Boston Celtics 112, Los Angeles Lakers 104');
    });

    it('should extract game dates from date picker', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toBe('2026-02-16');
      });
    });
  });

  describe('discoverUrls', () => {
    it('should extract game detail page links', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const urls = adapter.discoverUrls!(html, 'nba');

      expect(urls.length).toBe(2);
      expect(urls[0]).toContain('/bet-hub/nba/games/bos-lal-20260216');
      expect(urls[1]).toContain('/bet-hub/nba/games/mil-gsw-20260216');
    });

    it('should resolve relative URLs to absolute', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const urls = adapter.discoverUrls!(html, 'nba');

      urls.forEach((url) => {
        expect(url).toMatch(/^https:\/\//);
      });
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array for page with no game cards', () => {
    const html = '<html><body><app-root><div class="games-container"></div></app-root></body></html>';
    const predictions = adapter.parse(html, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
