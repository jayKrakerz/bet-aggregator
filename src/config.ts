import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgres://betagg:betagg_dev@127.0.0.1:5433/bet_aggregator'),
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().default(6380),
  SNAPSHOT_DIR: z.string().default('./snapshots'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_SCORE_THRESHOLD: z.coerce.number().default(65),
  TELEGRAM_MAX_PICKS: z.coerce.number().default(5),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
