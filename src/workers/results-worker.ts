import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { QUEUE_NAMES } from '../scheduler/constants.js';
import { fetchEspnResults } from '../results/espn-fetcher.js';
import { fetchSoccer24Results } from '../results/soccer24-fetcher.js';
import { matchResults } from '../results/matcher.js';
import { gradePrediction } from '../results/grader.js';
import {
  insertMatchResult,
  getUngradedPredictions,
  updatePredictionGrade,
} from '../db/queries.js';
import { logger } from '../utils/logger.js';

interface ResultsJobData {
  sport: string;
  date: string;
}

const connection = { host: config.REDIS_HOST, port: config.REDIS_PORT };

/**
 * Fetch results from the appropriate source based on sport.
 * US sports use ESPN; football (soccer) uses Soccer24.
 */
async function fetchResultsForSport(sport: string, dateStr: string) {
  if (sport === 'football') {
    return fetchSoccer24Results(dateStr);
  }
  return fetchEspnResults(sport, dateStr);
}

export function createResultsWorker() {
  const worker = new Worker<ResultsJobData>(
    QUEUE_NAMES.RESULTS,
    async (job: Job<ResultsJobData>) => {
      const { sport, date } = job.data;
      const log = logger.child({ job: job.id, sport, date });

      // 1. Fetch results (ESPN for US sports, Soccer24 for football)
      const rawResults = await fetchResultsForSport(sport, date);
      if (!rawResults.length) {
        log.info('No results for this sport/date');
        return;
      }

      // 2. Match to internal records
      const matched = await matchResults(rawResults);
      if (!matched.length) {
        log.info('No results matched to internal matches');
        return;
      }

      let resultsInserted = 0;
      let predictionsGraded = 0;

      for (const result of matched) {
        // 3. Insert/update match result
        await insertMatchResult({
          matchId: result.matchId,
          homeScore: result.homeScore,
          awayScore: result.awayScore,
          status: result.status,
          resultSource: sport === 'football' ? 'soccer24' : 'espn',
        });
        resultsInserted++;

        // 4. Grade ungraded predictions for this match
        if (result.status === 'final') {
          const ungraded = await getUngradedPredictions(result.matchId);
          for (const pred of ungraded) {
            const grade = gradePrediction(pred, {
              homeScore: result.homeScore,
              awayScore: result.awayScore,
            });
            await updatePredictionGrade(pred.id, grade);
            predictionsGraded++;
          }
        } else {
          // Postponed/cancelled → void all predictions
          const ungraded = await getUngradedPredictions(result.matchId);
          for (const pred of ungraded) {
            await updatePredictionGrade(pred.id, 'void');
            predictionsGraded++;
          }
        }
      }

      log.info({ resultsInserted, predictionsGraded }, 'Results processing complete');
    },
    { connection, concurrency: 2 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.id, err: err.message }, 'Results job failed');
  });

  return worker;
}
