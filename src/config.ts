import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  FOOTBALL_API_KEY: z.string().optional(),
  TWITTER_BEARER_TOKEN: z.string().optional(),
  // Monetization / distribution
  SPORTY_AFFIL_TAG: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_MIN_EV_PCT: z.coerce.number().default(5),
  UNLOCK_KEYS: z.string().optional(), // comma-separated list of valid keys
  BUYMEACOFFEE_URL: z.string().optional(),
  ADSENSE_CLIENT_ID: z.string().optional(),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
