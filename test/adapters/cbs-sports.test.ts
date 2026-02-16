import { describe, it, expect } from 'vitest';
import { CbsSportsAdapter } from '../../src/adapters/cbs-sports.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('CbsSportsAdapter', () => {
  const adapter = new CbsSportsAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('cbs-sports');
    expect(adapter.config.fetchMethod).toBe('browser');
    expect(adapter.config.baseUrl).toBe('https://www.cbssports.com');
    expect(adapter.config.paths.nba).toBe('/nba/expert-picks/');
    expect(adapter.config.paths.nfl).toBe('/nfl/expert-picks/');
  });

  describe('parse (NBA expert picks)', () => {
    it('should parse predictions from expert picks grid', () => {
      const html = loadFixture('cbs-sports', 'nba-expert-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      // Game 1: 3 experts × 3 picks = 9, Game 2: 2 experts × 3 picks = 6 → total 15
      expect(predictions.length).toBe(15);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('cbs-sports');
        expect(p.sport).toBe('nba');
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(['spread', 'moneyline', 'over_under']).toContain(p.pickType);
      });
    });

    it('should use individual expert names as pickerName', () => {
      const html = loadFixture('cbs-sports', 'nba-expert-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const names = new Set(predictions.map((p) => p.pickerName));
      expect(names).toContain('Brad Botkin');
      expect(names).toContain('Sam Quinn');
      expect(names).toContain('Jack Maloney');
    });

    it('should resolve team abbreviations to correct sides', () => {
      const html = loadFixture('cbs-sports', 'nba-expert-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      // Brad Botkin picks BOS ATS for game 1 → away
      const bradAts = predictions.find(
        (p) => p.pickerName === 'Brad Botkin' &&
          p.homeTeamRaw === 'Los Angeles Lakers' &&
          p.pickType === 'spread',
      );
      expect(bradAts?.side).toBe('away');
      expect(bradAts?.value).toBe(-6.5);

      // Sam Quinn picks LAL ATS for game 1 → home
      const samAts = predictions.find(
        (p) => p.pickerName === 'Sam Quinn' &&
          p.homeTeamRaw === 'Los Angeles Lakers' &&
          p.pickType === 'spread',
      );
      expect(samAts?.side).toBe('home');
      expect(samAts?.value).toBe(6.5);
    });

    it('should parse over/under picks correctly', () => {
      const html = loadFixture('cbs-sports', 'nba-expert-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const ouPicks = predictions.filter((p) => p.pickType === 'over_under');
      expect(ouPicks.length).toBe(5);

      ouPicks.forEach((p) => {
        expect(['over', 'under']).toContain(p.side);
        expect(p.value).not.toBeNull();
      });

      // Brad Botkin picks Over 221.5 for game 1
      const bradOu = ouPicks.find(
        (p) => p.pickerName === 'Brad Botkin' && p.homeTeamRaw === 'Los Angeles Lakers',
      );
      expect(bradOu?.side).toBe('over');
      expect(bradOu?.value).toBe(221.5);
    });

    it('should map expert records to confidence', () => {
      const html = loadFixture('cbs-sports', 'nba-expert-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      // Brad Botkin: 85-62 → 57.8% → medium (52-60% range)
      const brad = predictions.find((p) => p.pickerName === 'Brad Botkin');
      expect(brad?.confidence).toBe('medium');

      // Sam Quinn: 79-68 → 53.7% → medium
      const sam = predictions.find((p) => p.pickerName === 'Sam Quinn');
      expect(sam?.confidence).toBe('medium');
    });

    it('should extract game date from page', () => {
      const html = loadFixture('cbs-sports', 'nba-expert-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toBe('2026-02-16');
      });
    });

    it('should include game times', () => {
      const html = loadFixture('cbs-sports', 'nba-expert-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const lalGame = predictions.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.gameTime).toBe('7:30 PM ET');
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array for grid with no game cards', () => {
    const html = '<html><body><div class="picks-grid"></div></body></html>';
    const predictions = adapter.parse(html, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
