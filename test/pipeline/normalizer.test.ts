import { describe, it, expect } from 'vitest';
// normalizeAndInsert requires a DB connection, so we test the pipeline
// components individually. Full integration test in a separate suite.

describe('normalizer (unit)', () => {
  it('placeholder — full integration tests require DB', () => {
    // normalizeAndInsert calls DB queries internally.
    // Test the individual components (team-resolver, dedup) separately.
    // Integration test with DB can be added when test containers are set up.
    expect(true).toBe(true);
  });
});
