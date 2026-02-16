import { describe, it, expect } from 'vitest';
import { DunkelIndexAdapter } from '../../src/adapters/dunkel-index.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('DunkelIndexAdapter', () => {
  const adapter = new DunkelIndexAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('dunkel-index');
    expect(adapter.config.fetchMethod).toBe('http');
    expect(adapter.config.baseUrl).toBe('https://www.dunkelindex.com');
    expect(adapter.config.paths.nba).toBe('/picks/nba');
    expect(adapter.config.paths.nfl).toBe('/picks/nfl');
    expect(adapter.config.paths.ncaab).toBe('/picks/ncaab');
  });

  describe('parse (NBA picks JSON)', () => {
    it('should parse predictions from JSON API response', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      // 3 games × 3 pick types (spread, o/u, ML) = 9
      expect(predictions.length).toBe(9);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('dunkel-index');
        expect(p.sport).toBe('nba');
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(p.pickerName).toBe('Dunkel Index Model');
        expect(['spread', 'moneyline', 'over_under']).toContain(p.pickType);
      });
    });

    it('should extract spread picks with correct sides', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      const spreads = predictions.filter((p) => p.pickType === 'spread');
      expect(spreads.length).toBe(3);

      spreads.forEach((p) => {
        expect(p.value).not.toBeNull();
        expect(typeof p.value).toBe('number');
        expect(['home', 'away']).toContain(p.side);
      });

      // LAL vs BOS: dunkel_line=-6.5 → away favored
      const lalBos = spreads.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalBos?.side).toBe('away');
      expect(lalBos?.value).toBe(-6.5);
    });

    it('should extract over/under picks with totals', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      const totals = predictions.filter((p) => p.pickType === 'over_under');
      expect(totals.length).toBe(3);

      totals.forEach((p) => {
        expect(p.value).not.toBeNull();
        expect(p.value).toBeGreaterThan(100);
        expect(['over', 'under']).toContain(p.side);
      });

      // LAL vs BOS: predicted 107+114=221 vs total 221.5 → under
      const lalBos = totals.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalBos?.side).toBe('under');
      expect(lalBos?.value).toBe(221.5);
    });

    it('should extract moneyline picks from win percentages', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      const mls = predictions.filter((p) => p.pickType === 'moneyline');
      expect(mls.length).toBe(3);

      mls.forEach((p) => {
        expect(['home', 'away']).toContain(p.side);
        expect(p.reasoning).toContain('Win prob:');
      });

      // BOS has 71.7% → away favored
      const lalBos = mls.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalBos?.side).toBe('away');
    });

    it('should include predicted scores in reasoning', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      const withPredicted = predictions.filter((p) => p.reasoning?.includes('Predicted:'));
      expect(withPredicted.length).toBeGreaterThan(0);
    });

    it('should map rank differences to confidence', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      const withConfidence = predictions.filter((p) => p.confidence !== null);
      expect(withConfidence.length).toBeGreaterThan(0);

      // LAL rank 12 vs BOS rank 3 → diff 9 → medium (5-9 range)
      const lalBos = predictions.find(
        (p) => p.homeTeamRaw === 'Los Angeles Lakers' && p.pickType === 'spread',
      );
      expect(lalBos?.confidence).toBe('medium');
    });

    it('should extract game dates in YYYY-MM-DD format', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array for malformed JSON', () => {
    const predictions = adapter.parse('{not valid json!!!', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should skip games with non-scheduled status', () => {
    const json = JSON.stringify({
      data: [
        {
          game_id: 1,
          home_team: 'Team A',
          away_team: 'Team B',
          game_date: '2026-02-16',
          home_rank: 1,
          away_rank: 2,
          home_rating: 90,
          away_rating: 85,
          dunkel_line: -3,
          dunkel_total: 200,
          dunkel_home_score: 105,
          dunkel_away_score: 100,
          home_moneyline: -150,
          away_moneyline: 130,
          home_win_pct: 60,
          away_win_pct: 40,
          status: 'final',
        },
      ],
    });
    const predictions = adapter.parse(json, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
