import { Queue } from 'bullmq';
import { config } from '../src/config.js';

const q = new Queue('fetch-queue', { connection: { host: config.REDIS_HOST, port: config.REDIS_PORT } });

const newIds = new Set(['soccertipz','forebet-tips','victorspredict','soccer24x7','betgaranteed','confirmbets','bettingclosed-tips','predictalot','tipsscore','soccerpredictions365']);

const waiting = await q.getWaiting(0, 200);
const delayed = await q.getDelayed(0, 200);
const active = await q.getActive(0, 10);

console.log(`Active: ${active.length}, Waiting: ${waiting.length}, Delayed: ${delayed.length}`);

let found = 0;
for (const j of [...waiting, ...delayed]) {
  if (newIds.has(j.data.adapterId)) {
    console.log(`  FOUND ${j.data.adapterId}:${j.data.sport} state=${await j.getState()} id=${j.id}`);
    found++;
  }
}
if (!found) {
  // Check completed
  const completed = await q.getCompleted(0, 200);
  for (const j of completed) {
    if (newIds.has(j.data.adapterId)) {
      console.log(`  COMPLETED ${j.data.adapterId}:${j.data.sport} id=${j.id}`);
      found++;
    }
  }
}
if (!found) console.log('  None of the new adapters found in any queue state!');

await q.close();
