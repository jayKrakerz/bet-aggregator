import { describe, it, expect } from 'vitest';
import { estimateWinProbability, scoreValue } from '../../src/api/scoring.js';

describe('Value Scoring', () => {
  describe('estimateWinProbability', () => {
    it('should return ~50% with no data', () => {
      const prob = estimateWinProbability({
        backingCount: 0,
        totalCount: 0,
        avgAccuracy: null,
        bestConfidence: null,
      });
      expect(prob).toBe(50);
    });

    it('should increase with strong consensus and high accuracy', () => {
      const prob = estimateWinProbability({
        backingCount: 5,
        totalCount: 7,
        avgAccuracy: 62,
        bestConfidence: 'high',
      });
      // 5/7 agree, sources at 62% accuracy, high confidence → should be well above 50%
      expect(prob).toBeGreaterThan(60);
      expect(prob).toBeLessThan(85);
    });

    it('should regress toward 50% with weak consensus', () => {
      const weak = estimateWinProbability({
        backingCount: 2,
        totalCount: 7,
        avgAccuracy: 62,
        bestConfidence: null,
      });
      const strong = estimateWinProbability({
        backingCount: 6,
        totalCount: 7,
        avgAccuracy: 62,
        bestConfidence: null,
      });
      expect(strong).toBeGreaterThan(weak);
    });

    it('should be higher with proven accuracy than without', () => {
      const proven = estimateWinProbability({
        backingCount: 4,
        totalCount: 6,
        avgAccuracy: 65,
        bestConfidence: null,
      });
      const unproven = estimateWinProbability({
        backingCount: 4,
        totalCount: 6,
        avgAccuracy: null,
        bestConfidence: null,
      });
      expect(proven).toBeGreaterThan(unproven);
    });

    it('should boost for best_bet confidence', () => {
      const base = estimateWinProbability({
        backingCount: 3,
        totalCount: 5,
        avgAccuracy: 58,
        bestConfidence: null,
      });
      const bestBet = estimateWinProbability({
        backingCount: 3,
        totalCount: 5,
        avgAccuracy: 58,
        bestConfidence: 'best_bet',
      });
      expect(bestBet).toBeGreaterThan(base);
    });

    it('should clamp to 15-92% range', () => {
      const low = estimateWinProbability({
        backingCount: 1,
        totalCount: 10,
        avgAccuracy: 30,
        bestConfidence: null,
      });
      const high = estimateWinProbability({
        backingCount: 8,
        totalCount: 8,
        avgAccuracy: 90,
        bestConfidence: 'best_bet',
      });
      expect(low).toBeGreaterThanOrEqual(15);
      expect(high).toBeLessThanOrEqual(92);
    });
  });

  describe('scoreValue', () => {
    it('should return neutral score when no odds available', () => {
      const result = scoreValue(60, null);
      expect(result.score).toBe(7);
      expect(result.ev).toBeNull();
      expect(result.edge).toBeNull();
    });

    it('should score high for strong positive EV', () => {
      // 65% prob at 2.40 odds → EV = 0.65 × 2.40 - 1 = 56%
      const result = scoreValue(65, 2.40);
      expect(result.ev).toBeGreaterThan(50);
      expect(result.score).toBe(20);
      expect(result.edge).toBeGreaterThan(20);
    });

    it('should score low for negative EV', () => {
      // 55% prob at 1.25 odds → EV = 0.55 × 1.25 - 1 = -31.25%
      const result = scoreValue(55, 1.25);
      expect(result.ev).toBeLessThan(0);
      expect(result.score).toBe(0);
    });

    it('should score moderate for marginal positive EV', () => {
      // 55% prob at 1.90 odds → EV = 0.55 × 1.90 - 1 = 4.5%
      const result = scoreValue(55, 1.90);
      expect(result.ev).toBeGreaterThan(0);
      expect(result.ev).toBeLessThan(10);
      expect(result.score).toBeGreaterThanOrEqual(10);
    });

    it('should detect when market overprices the favorite', () => {
      // Market has team at 80% implied (1.25 odds), but we estimate only 60%
      const result = scoreValue(60, 1.25);
      expect(result.ev).toBeLessThan(0);
      expect(result.edge).toBeLessThan(0);
    });

    it('should detect value on underdogs', () => {
      // Market has team at 33% implied (3.00 odds), we estimate 45%
      const result = scoreValue(45, 3.00);
      // EV = 0.45 × 3.0 - 1 = 35%
      expect(result.ev).toBeGreaterThan(30);
      expect(result.edge).toBeGreaterThan(10);
      expect(result.score).toBe(20);
    });
  });
});
