import { describe, it, expect } from 'vitest';
import { DunkelIndexAdapter } from '../../src/adapters/dunkel-index.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('DunkelIndexAdapter', () => {
  const adapter = new DunkelIndexAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('dunkel-index');
    expect(adapter.config.fetchMethod).toBe('http');
    expect(adapter.config.baseUrl).toBe('https://www.dunkelindex.com');
    expect(adapter.config.paths.nba).toBe('/picks/get/3');
    expect(adapter.config.paths.nfl).toBe('/picks/get/1');
    expect(adapter.config.paths.ncaab).toBe('/picks/get/6');
  });

  describe('parse (NBA picks JSON)', () => {
    it('should parse predictions from JSON API response', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      // 2 scheduled games x 3 pick types (spread, o/u, ML) = 6
      // (third game has status "Final" and is skipped)
      expect(predictions.length).toBe(6);

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
      expect(spreads.length).toBe(2);

      spreads.forEach((p) => {
        expect(p.value).not.toBeNull();
        expect(typeof p.value).toBe('number');
        expect(['home', 'away']).toContain(p.side);
      });

      // LAL vs BOS: dunkel_pick=BOS, home_team_id=LAL → side=away, dunkel_line=-6.5
      const lalBos = spreads.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalBos?.side).toBe('away');
      expect(lalBos?.value).toBe(-6.5);
    });

    it('should extract over/under picks with totals', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      const totals = predictions.filter((p) => p.pickType === 'over_under');
      expect(totals.length).toBe(2);

      totals.forEach((p) => {
        expect(p.value).not.toBeNull();
        expect(p.value).toBeGreaterThan(100);
        expect(['over', 'under']).toContain(p.side);
      });

      // LAL vs BOS: dunkel_over_under="Under", dunkel_total=221.5
      const lalBos = totals.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalBos?.side).toBe('under');
      expect(lalBos?.value).toBe(221.5);

      // GSW vs MIL: dunkel_over_under="Over", dunkel_total=233.0
      const gswMil = totals.find((p) => p.homeTeamRaw === 'Golden State Warriors');
      expect(gswMil?.side).toBe('over');
      expect(gswMil?.value).toBe(233.0);
    });

    it('should extract moneyline picks from team_recommendation', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      const mls = predictions.filter((p) => p.pickType === 'moneyline');
      expect(mls.length).toBe(2);

      mls.forEach((p) => {
        expect(['home', 'away']).toContain(p.side);
      });

      // BOS team_recommendation=BOS, home_team_id=LAL → away
      const lalBos = mls.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalBos?.side).toBe('away');
      expect(lalBos?.value).toBe(-290);
    });

    it('should include Dunkel ratings in reasoning', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      const withRating = predictions.filter((p) => p.reasoning?.includes('Ratings:'));
      expect(withRating.length).toBeGreaterThan(0);
    });

    it('should include dunkel_pick_name in reasoning', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      const withPickName = predictions.filter((p) => p.reasoning?.includes('Dunkel pick:'));
      expect(withPickName.length).toBeGreaterThan(0);

      const lalBos = predictions.find(
        (p) => p.homeTeamRaw === 'Los Angeles Lakers' && p.pickType === 'spread',
      );
      expect(lalBos?.reasoning).toContain('Boston Celtics');
    });

    it('should include vegas_line in reasoning', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      const withVegas = predictions.filter((p) => p.reasoning?.includes('Vegas line:'));
      expect(withVegas.length).toBeGreaterThan(0);
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

      // GSW rank 8 vs MIL rank 5 → diff 3 → low (<5)
      const gswMil = predictions.find(
        (p) => p.homeTeamRaw === 'Golden State Warriors' && p.pickType === 'spread',
      );
      expect(gswMil?.confidence).toBe('low');
    });

    it('should extract game dates in YYYY-MM-DD format', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    });

    it('should extract game times from date_of_match', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      const lalBos = predictions.find(
        (p) => p.homeTeamRaw === 'Los Angeles Lakers' && p.pickType === 'spread',
      );
      expect(lalBos?.gameTime).toBe('19:30');
    });

    it('should skip games with non-scheduled status', () => {
      const json = loadFixture('dunkel-index', 'nba-picks.json');
      const predictions = adapter.parse(json, 'nba', new Date('2026-02-16'));

      // The third game (PHX vs DEN) has status "Final" and should be skipped
      const phxDen = predictions.find((p) => p.homeTeamRaw === 'Phoenix Suns');
      expect(phxDen).toBeUndefined();
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

  it('should skip games with non-scheduled status (inline JSON)', () => {
    const json = JSON.stringify({
      games: [
        {
          id: '99',
          home_team_full_name: 'Team A',
          away_team_full_name: 'Team B',
          date_of_match: '2026-02-16 19:00:00',
          home_team_id: 'A',
          away_team_id: 'B',
          home_team_key: 'A',
          away_team_key: 'B',
          home_team_rank: 1,
          away_team_rank: 2,
          home_team_dunkel_rating: '90',
          away_team_dunkel_rating: '85',
          dunkel_pick: 'A',
          dunkel_pick_name: 'Team A',
          dunkel_line: -3,
          dunkel_total: 200,
          dunkel_over_under: 'Over',
          team_recommendation: 'A',
          money_line: '-150',
          vegas_line: '-3.5',
          status: 'Final',
        },
      ],
    });
    const predictions = adapter.parse(json, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
