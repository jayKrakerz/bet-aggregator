import postgres from 'postgres';
import { config } from '../config.js';

const isVercel = !!process.env.VERCEL;

export const sql = postgres(config.DATABASE_URL, {
  max: isVercel ? 2 : 10,
  idle_timeout: isVercel ? 10 : 20,
  connect_timeout: 10,
});
