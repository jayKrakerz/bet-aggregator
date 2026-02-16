import postgres from 'postgres';

const sql = postgres(
  process.env['DATABASE_URL'] ||
    'postgres://betagg:betagg_dev@127.0.0.1:5433/bet_aggregator',
);

const NBA_TEAMS = [
  { name: 'Atlanta Hawks', abbr: 'ATL', aliases: ['Hawks', 'Atlanta'] },
  { name: 'Boston Celtics', abbr: 'BOS', aliases: ['Celtics', 'Boston'] },
  { name: 'Brooklyn Nets', abbr: 'BKN', aliases: ['Nets', 'Brooklyn'] },
  { name: 'Charlotte Hornets', abbr: 'CHA', aliases: ['Hornets', 'Charlotte'] },
  { name: 'Chicago Bulls', abbr: 'CHI', aliases: ['Bulls', 'Chicago'] },
  { name: 'Cleveland Cavaliers', abbr: 'CLE', aliases: ['Cavaliers', 'Cavs', 'Cleveland'] },
  { name: 'Dallas Mavericks', abbr: 'DAL', aliases: ['Mavericks', 'Mavs', 'Dallas'] },
  { name: 'Denver Nuggets', abbr: 'DEN', aliases: ['Nuggets', 'Denver'] },
  { name: 'Detroit Pistons', abbr: 'DET', aliases: ['Pistons', 'Detroit'] },
  { name: 'Golden State Warriors', abbr: 'GSW', aliases: ['Warriors', 'Golden State', 'GS Warriors'] },
  { name: 'Houston Rockets', abbr: 'HOU', aliases: ['Rockets', 'Houston'] },
  { name: 'Indiana Pacers', abbr: 'IND', aliases: ['Pacers', 'Indiana'] },
  { name: 'Los Angeles Clippers', abbr: 'LAC', aliases: ['Clippers', 'LA Clippers', 'L.A. Clippers'] },
  { name: 'Los Angeles Lakers', abbr: 'LAL', aliases: ['Lakers', 'LA Lakers', 'L.A. Lakers'] },
  { name: 'Memphis Grizzlies', abbr: 'MEM', aliases: ['Grizzlies', 'Memphis'] },
  { name: 'Miami Heat', abbr: 'MIA', aliases: ['Heat', 'Miami'] },
  { name: 'Milwaukee Bucks', abbr: 'MIL', aliases: ['Bucks', 'Milwaukee'] },
  { name: 'Minnesota Timberwolves', abbr: 'MIN', aliases: ['Timberwolves', 'Wolves', 'Minnesota'] },
  { name: 'New Orleans Pelicans', abbr: 'NOP', aliases: ['Pelicans', 'New Orleans'] },
  { name: 'New York Knicks', abbr: 'NYK', aliases: ['Knicks', 'New York', 'NY Knicks'] },
  { name: 'Oklahoma City Thunder', abbr: 'OKC', aliases: ['Thunder', 'Oklahoma City'] },
  { name: 'Orlando Magic', abbr: 'ORL', aliases: ['Magic', 'Orlando'] },
  { name: 'Philadelphia 76ers', abbr: 'PHI', aliases: ['76ers', 'Sixers', 'Philadelphia'] },
  { name: 'Phoenix Suns', abbr: 'PHX', aliases: ['Suns', 'Phoenix'] },
  { name: 'Portland Trail Blazers', abbr: 'POR', aliases: ['Trail Blazers', 'Blazers', 'Portland'] },
  { name: 'Sacramento Kings', abbr: 'SAC', aliases: ['Kings', 'Sacramento'] },
  { name: 'San Antonio Spurs', abbr: 'SAS', aliases: ['Spurs', 'San Antonio'] },
  { name: 'Toronto Raptors', abbr: 'TOR', aliases: ['Raptors', 'Toronto'] },
  { name: 'Utah Jazz', abbr: 'UTA', aliases: ['Jazz', 'Utah'] },
  { name: 'Washington Wizards', abbr: 'WAS', aliases: ['Wizards', 'Washington'] },
];

async function seed() {
  console.log('Seeding NBA teams...');

  for (const team of NBA_TEAMS) {
    const [inserted] = await sql`
      INSERT INTO teams (name, abbreviation, sport)
      VALUES (${team.name}, ${team.abbr}, 'nba')
      ON CONFLICT (abbreviation, sport) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    const teamId = inserted?.id as number;

    // Insert full name and abbreviation as aliases too
    const allAliases = [team.name, team.abbr, ...team.aliases];
    for (const alias of allAliases) {
      await sql`
        INSERT INTO team_aliases (team_id, alias)
        VALUES (${teamId}, ${alias})
        ON CONFLICT (alias, team_id) DO NOTHING
      `;
    }
  }

  console.log(`Seeded ${NBA_TEAMS.length} NBA teams.`);
  await sql.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
