import { describe, it, expect } from 'vitest';
import { ScoresAndOddsAdapter } from '../../src/adapters/scores-and-odds.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('ScoresAndOddsAdapter', () => {
  const adapter = new ScoresAndOddsAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('scores-and-odds');
    expect(adapter.config.fetchMethod).toBe('http');
    expect(adapter.config.baseUrl).toBe('https://www.scoresandodds.com');
    expect(adapter.config.paths.nba).toBe('/nba/consensus-picks');
    expect(adapter.config.paths.nfl).toBe('/nfl/consensus-picks');
    expect(adapter.config.paths.ncaab).toBe('/ncaab/consensus-picks');
  });

  describe('parse (NBA consensus)', () => {
    it('should parse predictions from trend cards', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      // 1 game x 3 pick types (moneyline, spread, total) = 3
      expect(predictions.length).toBe(3);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('scores-and-odds');
        expect(p.sport).toBe('nba');
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(p.pickerName).toBe('ScoresAndOdds Consensus');
        expect(['spread', 'moneyline', 'over_under']).toContain(p.pickType);
      });
    });

    it('should extract team names from event header team-pennant', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      // Away team (first team-pennant) = Boston Celtics
      // Home team (second team-pennant) = Los Angeles Lakers
      const ml = predictions.find((p) => p.pickType === 'moneyline');
      expect(ml?.awayTeamRaw).toBe('Boston Celtics');
      expect(ml?.homeTeamRaw).toBe('Los Angeles Lakers');
    });

    it('should extract moneyline pick with consensus side and ML value', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const ml = predictions.find((p) => p.pickType === 'moneyline');
      // 75% away vs 25% home -> side=away
      expect(ml?.side).toBe('away');
      expect(ml?.value).toBe(-280);
      expect(ml?.reasoning).toContain('75%');
    });

    it('should extract spread pick with consensus direction', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const spread = predictions.find((p) => p.pickType === 'spread');
      // 68% away vs 32% home -> side=away
      expect(spread?.side).toBe('away');
      expect(spread?.value).toBe(-6.5);
      expect(spread?.reasoning).toContain('68%');
    });

    it('should extract over/under pick with total value', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const total = predictions.find((p) => p.pickType === 'over_under');
      // 58% over vs 42% under -> side=over
      expect(total?.side).toBe('over');
      expect(total?.value).toBe(221.5);
      expect(total?.reasoning).toContain('58%');
    });

    it('should map consensus percentages to confidence', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      // 75% -> best_bet
      const ml = predictions.find((p) => p.pickType === 'moneyline');
      expect(ml?.confidence).toBe('best_bet');

      // 68% -> high
      const spread = predictions.find((p) => p.pickType === 'spread');
      expect(spread?.confidence).toBe('high');

      // 58% -> medium
      const total = predictions.find((p) => p.pickType === 'over_under');
      expect(total?.confidence).toBe('medium');
    });

    it('should extract game date from fetchedAt', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toBe('2026-02-16');
      });
    });

    it('should extract game time from localtime span', () => {
      const html = loadFixture('scores-and-odds', 'nba-consensus.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameTime).toBe('7:30 PM ET');
      });
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array for page with no trend cards', () => {
    const html = '<html><body><div class="page-content"></div></body></html>';
    const predictions = adapter.parse(html, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
