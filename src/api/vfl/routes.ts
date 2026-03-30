import type { FastifyPluginAsync } from 'fastify';
import { WeekResultsSchema, VflTeamSchema } from './types.js';
import { addWeekResults, deleteWeek, getLeagueList } from './store.js';
import { getTeamStats, getLeagueTable, classifyTeams, detectDisc, getAlerts, getTeamPredatorActivatorContext, getGoalConcedingAnalysis } from './analyzer.js';
import { generatePicks, generateProAnalysis } from './picks.js';
import { VFL_TEAMS } from './constants.js';

export const vflRoutes: FastifyPluginAsync = async (app) => {

  // POST /vfl/results — input match results for a week
  app.post('/results', async (request, reply) => {
    const parsed = WeekResultsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid data', details: parsed.error.issues });
    }

    await addWeekResults(parsed.data);
    return { success: true, week: parsed.data.week, league: parsed.data.league, matchCount: parsed.data.matches.length };
  });

  // DELETE /vfl/results — delete a week's results
  app.delete('/results', async (request, reply) => {
    const { league, week } = request.query as { league?: string; week?: string };
    if (!league || !week) return reply.status(400).send({ error: 'league and week required' });

    const deleted = await deleteWeek(league, parseInt(week, 10));
    return { success: deleted };
  });

  // GET /vfl/leagues — list all leagues
  app.get('/leagues', async () => {
    return { leagues: getLeagueList() };
  });

  // GET /vfl/analysis — full analysis for a league
  app.get('/analysis', async (request, reply) => {
    const { league } = request.query as { league?: string };
    if (!league) return reply.status(400).send({ error: 'league required' });

    const table = getLeagueTable(league);
    const disc = detectDisc(league);
    const classification = classifyTeams(league);
    const alerts = getAlerts(league);
    const { topScorers, topConceders } = getGoalConcedingAnalysis(league);

    return {
      table,
      disc,
      predators: classification.predators,
      activators: classification.activators,
      observed: classification.observed,
      alerts,
      topScorers,
      topConceders,
      weekCount: table.length > 0 ? Math.max(...table.map(t => t.played)) : 0,
    };
  });

  // GET /vfl/picks — pick suggestions
  app.get('/picks', async (request, reply) => {
    const { league, week } = request.query as { league?: string; week?: string };
    if (!league || !week) return reply.status(400).send({ error: 'league and week required' });

    const result = generatePicks(league, parseInt(week, 10));
    const proAnalysis = generateProAnalysis(league);

    return { ...result, proAnalysis };
  });

  // GET /vfl/teams/:team — detailed team stats
  app.get('/teams/:team', async (request, reply) => {
    const { team } = request.params as { team?: string };
    const { league } = request.query as { league?: string };
    if (!league) return reply.status(400).send({ error: 'league required' });

    const parsed = VflTeamSchema.safeParse(team?.toUpperCase());
    if (!parsed.success) return reply.status(400).send({ error: `Invalid team. Valid: ${VFL_TEAMS.join(', ')}` });

    const stats = getTeamStats(league, parsed.data);
    if (!stats) return reply.status(404).send({ error: 'No data for this team/league' });

    const paContext = getTeamPredatorActivatorContext(league, parsed.data);

    return { stats, ...paContext };
  });

  // GET /vfl/teams — all teams overview
  app.get('/teams', async (request, reply) => {
    const { league } = request.query as { league?: string };
    if (!league) return reply.status(400).send({ error: 'league required' });

    const teams = VFL_TEAMS.map(t => {
      const stats = getTeamStats(league, t);
      return stats;
    }).filter(s => s !== null && s.played > 0);

    return { teams };
  });
};
