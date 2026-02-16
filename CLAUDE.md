# bet-aggregator

## What is this?
A betting prediction aggregator that scrapes free picks/predictions from multiple
sports betting sites (Covers.com, OddsShark, Pickswise), normalizes them, and
serves them via a REST API.

## Tech stack
- **Runtime**: Node.js 18, TypeScript (strict mode, ESM)
- **Package manager**: pnpm
- **Database**: PostgreSQL 16 (Docker), raw SQL migrations, postgres.js driver
- **Queue**: BullMQ on Redis 7 (Docker)
- **HTTP**: undici for server-rendered sites, Playwright for SPAs
- **Parsing**: cheerio
- **API**: Fastify 5
- **Testing**: vitest

## Key commands
- `pnpm dev` - Start dev server with tsx watch
- `pnpm build` - TypeScript build
- `pnpm test` - Run vitest
- `pnpm migrate` - Run SQL migrations
- `pnpm seed` - Seed NBA teams + aliases
- `pnpm docker:up` - Start PostgreSQL + Redis containers
- `pnpm docker:down` - Stop containers
- `pnpm db:reset` - Nuke DB, recreate, migrate, seed

## Architecture
- **Adapters** (`src/adapters/`): One per site. Implements `SiteAdapter` interface.
  Each defines config (URL, cron, rate limit) and a `parse(html)` method.
- **Scheduler** (`src/scheduler/`): BullMQ job schedulers, one per adapter+sport.
- **Workers** (`src/workers/`): Fetch worker (HTTP or browser) and parse worker.
- **Pipeline** (`src/pipeline/`): Normalize team names, dedup, insert to DB.
- **API** (`src/api/`): Fastify routes. Bull Board at /admin/queues.
- **Compliance** (`src/compliance/`): robots.txt checker, per-source rate limiter.
- **Snapshots** (`./snapshots/`): Raw HTML saved to disk with JSON sidecar metadata.

## Conventions
- All imports use `.js` extension (ESM)
- SQL migrations are numbered `NNN_description.sql`
- One adapter class per file in `src/adapters/`
- Tests use HTML fixtures in `test/fixtures/{source}/`
- No ORM. All queries in `src/db/queries.ts` using tagged template literals.
- Config validated with zod in `src/config.ts`

## Docker ports (avoid conflicts with local services)
- PostgreSQL: 5433 (mapped from container 5432)
- Redis: 6380 (mapped from container 6379)
