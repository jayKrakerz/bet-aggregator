import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { predictionsRoutes } from '../src/api/routes/predictions.js';

let app: ReturnType<typeof Fastify> | null = null;

// ===== IN-MEMORY RATE LIMITER =====
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 30;       // max requests per window
const RATE_WINDOW_MS = 60000; // 1 minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// Clean stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 300000);

// ===== ALLOWED ORIGINS =====
const ALLOWED_ORIGINS = new Set([
  'https://bet-aggregator-three.vercel.app',
  'https://bet-aggregator.vercel.app',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

function getAllowedOrigin(reqOrigin: string | undefined): string | null {
  if (!reqOrigin) return null;
  // Allow any *.vercel.app subdomain for preview deployments
  if (reqOrigin.endsWith('.vercel.app') && reqOrigin.startsWith('https://')) return reqOrigin;
  if (ALLOWED_ORIGINS.has(reqOrigin)) return reqOrigin;
  return null;
}

async function getApp() {
  if (app) return app;

  app = Fastify({
    logger: false,
    bodyLimit: 16384, // 16KB max request body
  });

  // CORS — restrict to own domains
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    const allowed = getAllowedOrigin(origin as string);
    if (allowed) {
      void reply.header('Access-Control-Allow-Origin', allowed);
      void reply.header('Vary', 'Origin');
    }
    void reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    void reply.header('Access-Control-Allow-Headers', 'Content-Type');
  });

  // Rate limiting
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const ip = req.headers['x-forwarded-for'] as string || req.ip || 'unknown';
    const clientIp = ip.split(',')[0]!.trim();
    if (!checkRateLimit(clientIp)) {
      void reply.status(429).send({ error: 'Too many requests. Try again in a minute.' });
    }
  });

  // Security headers
  app.addHook('onSend', async (_req: FastifyRequest, reply: FastifyReply) => {
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('X-Frame-Options', 'DENY');
    void reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  // OPTIONS preflight
  app.options('/*', async (_req: FastifyRequest, reply: FastifyReply) => reply.status(204).send());

  // Health
  app.get('/health', async () => ({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    wsClients: 0,
    services: { database: 'n/a' },
  }));

  await app.register(predictionsRoutes, { prefix: '/predictions' });
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const fastify = await getApp();
  fastify.server.emit('request', req, res);
}
