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
    it('should parse predictions from game links', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      // Game 1 (BOS@LAL): moneyline + spread = 2
      // Game 2 (MIL@GSW): moneyline + spread = 2
      // Game 3 (PHX@DEN): completed — skipped
      expect(predictions.length).toBe(4);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('dimers');
        expect(p.sport).toBe('nba');
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(p.pickerName).toBe('Dimers Model');
        expect(['spread', 'moneyline']).toContain(p.pickType);
      });
    });

    it('should skip games with completed status', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const phxPicks = predictions.filter(
        (p) => p.homeTeamRaw === 'DEN' || p.awayTeamRaw === 'PHX',
      );
      expect(phxPicks.length).toBe(0);
    });

    it('should extract moneyline picks with win probability', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const mls = predictions.filter((p) => p.pickType === 'moneyline');
      expect(mls.length).toBe(2);

      // BOS @ LAL: BOS away with 73% win prob -> high confidence (>= 65)
      const lalMl = mls.find((p) => p.homeTeamRaw === 'LAL');
      expect(lalMl?.side).toBe('away');
      expect(lalMl?.value).toBeNull();
      expect(lalMl?.confidence).toBe('high');
      expect(lalMl?.reasoning).toBe('Win prob: BOS 73%, LAL 27%');

      // MIL @ GSW: MIL away with 58% win prob
      const gswMl = mls.find((p) => p.homeTeamRaw === 'GSW');
      expect(gswMl?.side).toBe('away');
      expect(gswMl?.value).toBeNull();
      expect(gswMl?.confidence).toBe('medium');
      expect(gswMl?.reasoning).toBe('Win prob: MIL 58%, GSW 42%');
    });

    it('should extract spread picks', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const spreads = predictions.filter((p) => p.pickType === 'spread');
      expect(spreads.length).toBe(2);

      // BOS @ LAL: BOS -6.5
      const lalSpread = spreads.find((p) => p.homeTeamRaw === 'LAL');
      expect(lalSpread?.side).toBe('away');
      expect(lalSpread?.value).toBe(-6.5);
      expect(lalSpread?.reasoning).toBe('Spread: BOS -6.5, LAL +6.5');

      // MIL @ GSW: MIL -2.0
      const gswSpread = spreads.find((p) => p.homeTeamRaw === 'GSW');
      expect(gswSpread?.side).toBe('away');
      expect(gswSpread?.value).toBe(-2.0);
      expect(gswSpread?.reasoning).toBe('Spread: MIL -2.0, GSW +2.0');
    });

    it('should assign confidence based on win probability', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      // BOS 73% → high (>= 65)
      const bosPick = predictions.find(
        (p) => p.homeTeamRaw === 'LAL' && p.pickType === 'moneyline',
      );
      expect(bosPick?.confidence).toBe('high');

      // MIL 58% → medium (55-64 range)
      const milPick = predictions.find(
        (p) => p.homeTeamRaw === 'GSW' && p.pickType === 'moneyline',
      );
      expect(milPick?.confidence).toBe('medium');
    });

    it('should use team abbreviations from new DOM structure', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const teamNames = predictions.flatMap((p) => [p.awayTeamRaw, p.homeTeamRaw]);
      // All team names should be abbreviations, not full names
      expect(teamNames).toContain('BOS');
      expect(teamNames).toContain('LAL');
      expect(teamNames).toContain('MIL');
      expect(teamNames).toContain('GSW');
      expect(teamNames).not.toContain('Boston Celtics');
      expect(teamNames).not.toContain('Los Angeles Lakers');
    });

    it('should extract game time from .game-info', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const lalPick = predictions.find((p) => p.homeTeamRaw === 'LAL');
      expect(lalPick?.gameTime).toBe('7:30 PM, Feb 16');

      const gswPick = predictions.find((p) => p.homeTeamRaw === 'GSW');
      expect(gswPick?.gameTime).toBe('10:00 PM, Feb 16');
    });

    it('should extract game dates from fetchedAt', () => {
      const html = loadFixture('dimers', 'nba-schedule.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toBe('2026-02-16');
      });
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array for page with no game links', () => {
    const html = '<html><body><app-root><div class="game-sport-group"></div></app-root></body></html>';
    const predictions = adapter.parse(html, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
