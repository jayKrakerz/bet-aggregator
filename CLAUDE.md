# bet-aggregator

## What is this?
A Sportybet booking codes aggregator that scrapes free codes from tipster sites
and the Sportybet Code Hub API, validates them, and serves them via a REST API
with a frontend dashboard.

## Tech stack
- **Runtime**: Node.js 18, TypeScript (strict mode, ESM)
- **Package manager**: pnpm
- **HTTP**: native fetch + cheerio for HTML parsing
- **API**: Fastify 5 with @fastify/static
- **Config**: zod-validated env

## Key commands
- `pnpm dev` - Start dev server with tsx watch
- `pnpm build` - TypeScript build
- `pnpm start` - Run compiled JS

## Architecture
- **API** (`src/api/`): Fastify server with routes for booking codes
- **Scrapers** (`src/api/booking-codes-scraper.ts`, `src/api/social-codes-scraper.ts`):
  Scrape booking codes from tipster sites + Sportybet Code Hub API
- **Routes** (`src/api/routes/`): health check + predictions (booking codes, track codes, load/create code)
- **Config** (`src/config.ts`): zod-validated env (PORT, NODE_ENV, LOG_LEVEL)
- **Frontend** (`public/index.html`): Dashboard UI

## Conventions
- All imports use `.js` extension (ESM)
- No ORM, no database — all data is scraped live and cached in-memory
- Config validated with zod in `src/config.ts`
