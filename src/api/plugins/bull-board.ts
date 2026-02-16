import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import type { FastifyPluginAsync } from 'fastify';
import { fetchQueue, parseQueue } from '../../scheduler/queues.js';

export const bullBoardPlugin: FastifyPluginAsync = async (app) => {
  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues: [new BullMQAdapter(fetchQueue), new BullMQAdapter(parseQueue)],
    serverAdapter,
  });

  await app.register(serverAdapter.registerPlugin(), {
    prefix: '/admin/queues',
  });
};
