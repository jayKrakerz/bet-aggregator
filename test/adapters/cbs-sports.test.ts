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

    it('should produce 8 total predictions (2 games x 2 experts x 2 picks)', () => {
      expect(predictions).toBeInstanceOf(Array);
      expect(predictions.length).toBe(8);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('cbs-sports');
        expect(p.sport).toBe('nba');
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(['spread', 'over_under']).toContain(p.pickType);
      });
    });

    it('should have correct expert names', () => {
      const names = new Set(predictions.map((p) => p.pickerName));
      expect(names.size).toBe(2);
      expect(names).toContain('Brad Botkin');
      expect(names).toContain('Sam Quinn');
    });

    it('should parse spread picks with correct values', () => {
      const spreads = predictions.filter((p) => p.pickType === 'spread');
      expect(spreads.length).toBe(4);

      // Game 1 (BOS @ LAL): Brad picks LAL +6.5, Sam picks BOS -6.5
      const bradSpreadG1 = spreads.find(
        (p) => p.pickerName === 'Brad Botkin' && p.homeTeamRaw === 'LAL',
      );
      expect(bradSpreadG1).toBeDefined();
      expect(bradSpreadG1?.value).toBe(6.5);
      expect(bradSpreadG1?.side).toBe('home');

      const samSpreadG1 = spreads.find(
        (p) => p.pickerName === 'Sam Quinn' && p.homeTeamRaw === 'LAL',
      );
      expect(samSpreadG1).toBeDefined();
      expect(samSpreadG1?.value).toBe(-6.5);
      expect(samSpreadG1?.side).toBe('away');

      // Game 2 (MIL @ GSW): Brad picks GSW +3, Sam picks MIL -3
      const bradSpreadG2 = spreads.find(
        (p) => p.pickerName === 'Brad Botkin' && p.homeTeamRaw === 'GSW',
      );
      expect(bradSpreadG2).toBeDefined();
      expect(bradSpreadG2?.value).toBe(3);
      expect(bradSpreadG2?.side).toBe('home');

      const samSpreadG2 = spreads.find(
        (p) => p.pickerName === 'Sam Quinn' && p.homeTeamRaw === 'GSW',
      );
      expect(samSpreadG2).toBeDefined();
      expect(samSpreadG2?.value).toBe(-3);
      expect(samSpreadG2?.side).toBe('away');
    });

    it('should parse over/under picks with correct side and value', () => {
      const ouPicks = predictions.filter((p) => p.pickType === 'over_under');
      expect(ouPicks.length).toBe(4);

      ouPicks.forEach((p) => {
        expect(['over', 'under']).toContain(p.side);
        expect(p.value).not.toBeNull();
      });

      // Game 1 (BOS @ LAL): total 233.5 — Brad over, Sam under
      const bradOuG1 = ouPicks.find(
        (p) => p.pickerName === 'Brad Botkin' && p.homeTeamRaw === 'LAL',
      );
      expect(bradOuG1?.side).toBe('over');
      expect(bradOuG1?.value).toBe(233.5);

      const samOuG1 = ouPicks.find(
        (p) => p.pickerName === 'Sam Quinn' && p.homeTeamRaw === 'LAL',
      );
      expect(samOuG1?.side).toBe('under');
      expect(samOuG1?.value).toBe(233.5);

      // Game 2 (MIL @ GSW): total 228 — Brad over, Sam under
      const bradOuG2 = ouPicks.find(
        (p) => p.pickerName === 'Brad Botkin' && p.homeTeamRaw === 'GSW',
      );
      expect(bradOuG2?.side).toBe('over');
      expect(bradOuG2?.value).toBe(228);

      const samOuG2 = ouPicks.find(
        (p) => p.pickerName === 'Sam Quinn' && p.homeTeamRaw === 'GSW',
      );
      expect(samOuG2?.side).toBe('under');
      expect(samOuG2?.value).toBe(228);
    });

    it('should set gameDate from fetchedAt', () => {
      predictions.forEach((p) => {
        expect(p.gameDate).toBe('2026-02-16');
      });
    });

    it('should set gameTime to null', () => {
      predictions.forEach((p) => {
        expect(p.gameTime).toBeNull();
      });
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array for page with no experts-panel', () => {
    const html = '<html><body><div class="picks-grid"></div></body></html>';
    const predictions = adapter.parse(html, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
