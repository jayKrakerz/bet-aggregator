import { describe, it, expect } from 'vitest';
import { computeDedupKey } from '../../src/pipeline/dedup.js';

describe('computeDedupKey', () => {
  it('should produce consistent keys for same input', () => {
    const input = {
      sourceId: 'covers-com',
      matchId: 42,
      pickType: 'spread',
      side: 'home',
      pickerName: 'John Sharp',
    };

    const key1 = computeDedupKey(input);
    const key2 = computeDedupKey(input);
    expect(key1).toBe(key2);
  });

  it('should produce different keys for different inputs', () => {
    const key1 = computeDedupKey({
      sourceId: 'covers-com',
      matchId: 42,
      pickType: 'spread',
      side: 'home',
      pickerName: 'John Sharp',
    });

    const key2 = computeDedupKey({
      sourceId: 'covers-com',
      matchId: 42,
      pickType: 'moneyline',
      side: 'home',
      pickerName: 'John Sharp',
    });

    expect(key1).not.toBe(key2);
  });

  it('should normalize picker name case', () => {
    const key1 = computeDedupKey({
      sourceId: 'covers-com',
      matchId: 1,
      pickType: 'spread',
      side: 'home',
      pickerName: 'John Sharp',
    });

    const key2 = computeDedupKey({
      sourceId: 'covers-com',
      matchId: 1,
      pickType: 'spread',
      side: 'home',
      pickerName: 'john sharp',
    });

    expect(key1).toBe(key2);
  });

  it('should produce a 32-char hex string', () => {
    const key = computeDedupKey({
      sourceId: 'test',
      matchId: 1,
      pickType: 'spread',
      side: 'home',
      pickerName: 'tester',
    });

    expect(key).toMatch(/^[a-f0-9]{32}$/);
  });
});
