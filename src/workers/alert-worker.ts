import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { QUEUE_NAMES } from '../scheduler/constants.js';
import { sendTelegramPicks } from '../notifications/telegram.js';
import { isAlertSent, markAlertSent } from '../notifications/alert-dedup.js';
import { sql } from '../db/pool.js';
import { type MatchPick, scoreMatch, groupByMatch } from '../api/scoring.js';
import { logger } from '../utils/logger.js';

const connection = { host: config.REDIS_HOST, port: config.REDIS_PORT };

export function createAlertWorker() {
  const worker = new Worker(
    QUEUE_NAMES.ALERT,
    async (_job: Job) => {
      if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
        return;
      }

      const log = logger.child({ worker: 'alert' });

      // Fetch today's picks
      const picks = await sql<MatchPick[]>`
        SELECT
          m.id as match_id,
          to_char(m.game_date, 'YYYY-MM-DD') as game_date,
          m.game_time,
          m.sport,
          ht.name as home_team,
          att.name as away_team,
          m.home_team_id,
          m.away_team_id,
          p.pick_type,
          p.side,
          p.value,
          s.name as source_name,
          p.picker_name,
          p.confidence,
          p.reasoning
        FROM predictions p
        JOIN matches m ON m.id = p.match_id
        JOIN teams ht ON ht.id = m.home_team_id
        JOIN teams att ON att.id = m.away_team_id
        JOIN sources s ON s.id = p.source_id
        WHERE m.game_date = CURRENT_DATE
        ORDER BY m.game_date, m.id
      `;

      const matchMap = groupByMatch(picks);
      const scored = [];

      for (const [matchId, { info, picks: matchPicks }] of matchMap) {
        const result = await scoreMatch(matchId, info, matchPicks);
        if (result && result.score >= config.TELEGRAM_SCORE_THRESHOLD) {
          scored.push(result);
        }
      }

      scored.sort((a, b) => b.score - a.score);
      const topPicks = scored.slice(0, config.TELEGRAM_MAX_PICKS);

      // Filter out already-sent alerts
      const toSend = [];
      for (const pick of topPicks) {
        const key = `${pick.matchId}:${pick.recommendation}`;
        if (!(await isAlertSent(key))) {
          toSend.push(pick);
        }
      }

      if (!toSend.length) {
        log.info('No new picks to alert');
        return;
      }

      await sendTelegramPicks(toSend);

      for (const pick of toSend) {
        await markAlertSent(`${pick.matchId}:${pick.recommendation}`);
      }

      log.info({ count: toSend.length }, 'Telegram alerts sent');
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.id, err: err.message }, 'Alert job failed');
  });

  return worker;
}
