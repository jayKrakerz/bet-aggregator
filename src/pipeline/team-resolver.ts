import { sql } from '../db/pool.js';
import { logger } from '../utils/logger.js';

// In-memory cache: lowercase alias -> team ID
const aliasMap = new Map<string, number>();

export async function loadTeamAliases(): Promise<void> {
  const teams = await sql<{ id: number; name: string; abbreviation: string }[]>`
    SELECT id, name, abbreviation FROM teams
  `;
  const aliases = await sql<{ alias: string; team_id: number }[]>`
    SELECT alias, team_id FROM team_aliases
  `;

  aliasMap.clear();

  for (const team of teams) {
    aliasMap.set(team.name.toLowerCase(), team.id);
    aliasMap.set(team.abbreviation.toLowerCase(), team.id);
  }
  for (const alias of aliases) {
    aliasMap.set(alias.alias.toLowerCase(), alias.team_id);
  }

  logger.info({ aliasCount: aliasMap.size }, 'Team aliases loaded');
}

export function resolveTeamId(rawName: string): number | null {
  return aliasMap.get(rawName.toLowerCase().trim()) ?? null;
}

export function getAliasCount(): number {
  return aliasMap.size;
}
