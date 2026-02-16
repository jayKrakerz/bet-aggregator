import { describe, it, expect, beforeAll } from 'vitest';
import { loadTeamAliases, resolveTeamId, getAliasCount } from '../../src/pipeline/team-resolver.js';

// These tests require a running database with seeded data.
// Skip in CI if DB is not available.
const DB_AVAILABLE = process.env['DATABASE_URL'] || process.env['NODE_ENV'] !== 'test';

describe.skipIf(!DB_AVAILABLE)('teamResolver (integration)', () => {
  beforeAll(async () => {
    await loadTeamAliases();
  });

  it('should load aliases from database', () => {
    expect(getAliasCount()).toBeGreaterThan(0);
  });

  it('should resolve full team name', () => {
    const id = resolveTeamId('Los Angeles Lakers');
    expect(id).toBeTypeOf('number');
    expect(id).toBeGreaterThan(0);
  });

  it('should resolve abbreviation', () => {
    const id = resolveTeamId('LAL');
    expect(id).toBeTypeOf('number');
  });

  it('should resolve alias', () => {
    const id = resolveTeamId('Lakers');
    expect(id).toBeTypeOf('number');
  });

  it('should be case-insensitive', () => {
    const id1 = resolveTeamId('lakers');
    const id2 = resolveTeamId('LAKERS');
    expect(id1).toBe(id2);
  });

  it('should return null for unknown teams', () => {
    const id = resolveTeamId('Nonexistent Team');
    expect(id).toBeNull();
  });
});
