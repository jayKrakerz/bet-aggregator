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
    const html = loadFixture('cbs-sports', 'nba-expert-picks.html');
    const fetchedAt = new Date('2026-02-16');
    const predictions = adapter.parse(html, 'nba', fetchedAt);

    it('should produce 4 total predictions (2 games x 1 expert x 2 pick types)', () => {
      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBe(4);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('cbs-sports');
        expect(p.sport).toBe('nba');
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(['spread', 'over_under']).toContain(p.pickType);
      });
    });

    it('should use the expert name from the sidebar panel', () => {
      const names = new Set(predictions.map((p) => p.pickerName));
      expect(names.size).toBe(1);
      expect(names).toContain('CBS Sports Staff');
    });

    it('should parse spread picks with correct values and sides', () => {
      const spreads = predictions.filter((p) => p.pickType === 'spread');
      expect(spreads.length).toBe(2);

      // Game 1 (BOS @ LAL): expert picks LAL +6.5 — LAL is home
      const spreadG1 = spreads.find((p) => p.homeTeamRaw === 'LA Lakers');
      expect(spreadG1).toBeDefined();
      expect(spreadG1?.value).toBe(6.5);
      expect(spreadG1?.side).toBe('home');
      expect(spreadG1?.awayTeamRaw).toBe('Boston');

      // Game 2 (MIL @ GSW): expert picks MIL -3 — MIL is away
      const spreadG2 = spreads.find((p) => p.homeTeamRaw === 'Golden St.');
      expect(spreadG2).toBeDefined();
      expect(spreadG2?.value).toBe(-3);
      expect(spreadG2?.side).toBe('away');
      expect(spreadG2?.awayTeamRaw).toBe('Milwaukee');
    });

    it('should parse over/under picks with correct side and value', () => {
      const ouPicks = predictions.filter((p) => p.pickType === 'over_under');
      expect(ouPicks.length).toBe(2);

      ouPicks.forEach((p) => {
        expect(['over', 'under']).toContain(p.side);
        expect(p.value).not.toBeNull();
      });

      // Game 1 (BOS @ LAL): total 233.5 — Over
      const ouG1 = ouPicks.find((p) => p.homeTeamRaw === 'LA Lakers');
      expect(ouG1?.side).toBe('over');
      expect(ouG1?.value).toBe(233.5);

      // Game 2 (MIL @ GSW): total 228 — Under
      const ouG2 = ouPicks.find((p) => p.homeTeamRaw === 'Golden St.');
      expect(ouG2?.side).toBe('under');
      expect(ouG2?.value).toBe(228);
    });

    it('should extract game date from preview link', () => {
      predictions.forEach((p) => {
        expect(p.gameDate).toBe('2026-02-16');
      });
    });

    it('should extract game time from the formatter element', () => {
      const g1 = predictions.find((p) => p.homeTeamRaw === 'LA Lakers');
      expect(g1?.gameTime).toBe('7:30PM');

      const g2 = predictions.find((p) => p.homeTeamRaw === 'Golden St.');
      expect(g2?.gameTime).toBe('10:00PM');
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array for page with no picks-tbody', () => {
    const html = '<html><body><div class="picks-grid"></div></body></html>';
    const predictions = adapter.parse(html, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
