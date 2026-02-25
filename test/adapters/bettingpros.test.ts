import { describe, it, expect } from 'vitest';
import { BettingProsAdapter } from '../../src/adapters/bettingpros.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('BettingProsAdapter', () => {
  const adapter = new BettingProsAdapter();

  it('should have correct config', () => {
    expect(adapter.config.id).toBe('bettingpros');
    expect(adapter.config.fetchMethod).toBe('browser');
    expect(adapter.config.baseUrl).toBe('https://www.bettingpros.com');
    expect(adapter.config.paths.nba).toBe('/nba/picks/');
    expect(adapter.config.paths.ncaab).toBe('/college-basketball/picks/');
  });

  describe('parse (new bet-signal carousel layout)', () => {
    it('should parse predictions from bet-signal carousel cards', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      expect(predictions).toBeInstanceOf(Array);
      // 2 games x 1 pick type (spread, since default market is spread) = 2
      expect(predictions.length).toBe(2);

      predictions.forEach((p) => {
        expect(p.sourceId).toBe('bettingpros');
        expect(p.sport).toBe('nba');
        expect(p.homeTeamRaw).toBeTruthy();
        expect(p.awayTeamRaw).toBeTruthy();
        expect(p.pickerName).toBe('BettingPros Consensus');
        expect(p.pickType).toBe('spread');
      });
    });

    it('should extract team names from logo alt text + team__name', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const lalGame = predictions.find(
        (p) => p.homeTeamRaw === 'Los Angeles Lakers',
      );
      expect(lalGame).toBeDefined();
      expect(lalGame?.awayTeamRaw).toBe('Boston Celtics');
      expect(lalGame?.homeTeamRaw).toBe('Los Angeles Lakers');
    });

    it('should extract spread picks with consensus direction', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const spreads = predictions.filter((p) => p.pickType === 'spread');
      expect(spreads.length).toBe(2);

      // BOS 77% vs LAL 23% -> away consensus -> away spread=-6.5
      const lalGame = spreads.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.side).toBe('away');
      expect(lalGame?.value).toBe(-6.5);
      expect(lalGame?.reasoning).toContain('77%');
      expect(lalGame?.reasoning).toContain('23%');

      // MIL 46% vs GSW 54% -> home consensus -> home spread=+2.0
      const gswGame = spreads.find((p) => p.homeTeamRaw === 'Golden State Warriors');
      expect(gswGame?.side).toBe('home');
      expect(gswGame?.value).toBe(2.0);
    });

    it('should map consensus percentages to confidence', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      // BOS 77% -> best_bet (>= 75)
      const lalSpread = predictions.find(
        (p) => p.homeTeamRaw === 'Los Angeles Lakers' && p.pickType === 'spread',
      );
      expect(lalSpread?.confidence).toBe('best_bet');

      // GSW 54% -> low (< 55)
      const gswSpread = predictions.find(
        (p) => p.homeTeamRaw === 'Golden State Warriors' && p.pickType === 'spread',
      );
      expect(gswSpread?.confidence).toBe('low');
    });

    it('should use fetchedAt date for gameDate', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      predictions.forEach((p) => {
        expect(p.gameDate).toBe('2026-02-16');
      });
    });

    it('should extract game time from card footer', () => {
      const html = loadFixture('bettingpros', 'nba-picks.html');
      const predictions = adapter.parse(html, 'nba', new Date('2026-02-16'));

      const lalGame = predictions.find((p) => p.homeTeamRaw === 'Los Angeles Lakers');
      expect(lalGame?.gameTime).toBe('2/16 7:30pm');

      const gswGame = predictions.find((p) => p.homeTeamRaw === 'Golden State Warriors');
      expect(gswGame?.gameTime).toBe('2/16 10:00pm');
    });
  });

  describe('parse (fallback to old game-picks-card layout)', () => {
    it('should parse old-style game cards when no bet-signal cards present', () => {
      const oldHtml = `<!DOCTYPE html>
<html><body><div id="app"><div class="picks-page"><div class="game-picks-module">
  <div class="game-picks-card--horizontal">
    <div class="game-picks-card-horizontal__side--left">
      <div class="team__name">Boston Celtics</div>
      <div class="team__percentage">77% of Bets</div>
      <button class="odds-cell"><span class="odds-cell__line">-6.5</span></button>
      <button class="odds-cell"><span class="odds-cell__line">-280</span></button>
      <button class="odds-cell"><span class="odds-cell__line">221.5</span></button>
    </div>
    <div class="game-picks-card-horizontal__side--right">
      <div class="team__name">Los Angeles Lakers</div>
      <div class="team__percentage">23% of Bets</div>
      <button class="odds-cell"><span class="odds-cell__line">+6.5</span></button>
      <button class="odds-cell"><span class="odds-cell__line">+230</span></button>
      <button class="odds-cell"><span class="odds-cell__line">221.5</span></button>
    </div>
  </div>
</div></div></div></body></html>`;
      const predictions = adapter.parse(oldHtml, 'nba', new Date('2026-02-16'));

      expect(predictions.length).toBe(3); // moneyline + spread + over_under

      const ml = predictions.find((p) => p.pickType === 'moneyline');
      expect(ml?.side).toBe('away');
      expect(ml?.value).toBe(-280);
      expect(ml?.confidence).toBe('best_bet');

      const spread = predictions.find((p) => p.pickType === 'spread');
      expect(spread?.side).toBe('away');
      expect(spread?.value).toBe(-6.5);

      const total = predictions.find((p) => p.pickType === 'over_under');
      expect(total?.side).toBe('over');
      expect(total?.value).toBe(221.5);
    });
  });

  it('should return empty array for empty HTML', () => {
    const predictions = adapter.parse('<html><body></body></html>', 'nba', new Date());
    expect(predictions).toEqual([]);
  });

  it('should return empty array for page with no game cards', () => {
    const html = '<html><body><div id="app"><div class="game-picks-module"></div></div></body></html>';
    const predictions = adapter.parse(html, 'nba', new Date());
    expect(predictions).toEqual([]);
  });
});
