# TeslaB

Monorepo with a **Next.js** frontend, an **Express** REST API, and a **PostgreSQL** database running in Docker.

## Structure

```
TeslaB/
├── client/                 # Next.js 16 (App Router, JavaScript, Tailwind CSS v4)
│   ├── src/
│   │   ├── app/            # Routes, layouts, and pages
│   │   │   ├── layout.js
│   │   │   ├── page.js     # Home page; fetches from the Express API
│   │   │   └── globals.css
│   │   └── lib/
│   │       └── api.js      # fetch wrapper for the Express API
│   ├── public/             # Static assets
│   ├── next.config.mjs     # /api/* proxy rewrite -> Express
│   └── .env.local.example
├── server/                 # Express 5 API (ESM)
│   ├── db/                 # SQL applied by migrate / on first container boot
│   │   ├── 01-schema.sql
│   │   ├── 02-seed.sql
│   │   └── 03-transport-network.sql   # zones, stops, corridors, travel estimates
│   ├── src/
│   │   ├── index.js        # HTTP server bootstrap + graceful shutdown
│   │   ├── app.js          # Express app: middleware, routes, error handling
│   │   ├── config/env.js   # Environment configuration
│   │   ├── db/             # pg pool, health probe, migration runner, seeder
│   │   │   └── seeds/      # transport demo data + idempotent upserts
│   │   ├── routes/         # Route definitions (index, health, users, transport)
│   │   ├── controllers/    # Request handlers
│   │   ├── services/       # Business logic / SQL queries
│   │   ├── serializers/    # Row -> response DTO mappers
│   │   ├── middleware/     # notFound, errorHandler
│   │   └── utils/          # ApiError, validation helpers
│   ├── test/               # node --test suites (unit + integration)
│   └── .env.example
├── docker-compose.yml      # PostgreSQL 17 (database "TeslaB")
├── .env.example            # Optional compose overrides
├── package.json            # npm workspaces + dev/build/db scripts
└── .gitignore
```

## Getting started

```bash
npm install                        # installs workspace deps (client + server)
npm run db:up                      # start PostgreSQL (docker compose)
cp client/.env.local.example client/.env.local
cp server/.env.example server/.env
npm run db:migrate                 # apply server/db/*.sql
npm run db:seed                    # apply the transport demo data
npm run dev                        # starts Express (:4000) and Next.js (:3000) together
```

Open http://localhost:3000 — the home page calls `GET /api/health` (API + database status) and `GET /api/users`.

The container runs `server/db/*.sql` automatically the first time its volume is created. To re-apply them at any point, run `npm run db:migrate` (the SQL is idempotent).

## Scripts (run from the repo root)

| Script                 | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `npm run dev`        | Run the API and the web client concurrently     |
| `npm run dev:server` | Express only, with`node --watch` on port 4000 |
| `npm run dev:client` | Next.js dev server on port 3000                 |
| `npm run build`      | Production build of the Next.js client          |
| `npm start`          | Run both apps in production mode                |
| `npm run lint`       | ESLint for the client                           |
| `npm run db:up`      | Start the PostgreSQL container                  |
| `npm run db:down`    | Stop the container (keeps data)                 |
| `npm run db:reset`   | Recreate the container **and wipe data**  |
| `npm run db:migrate` | Apply `server/db/*.sql` to the database      |
| `npm run db:seed`    | Apply the transport demo seed (idempotent)      |
| `npm run db:psql`    | Open a psql shell in the container              |
| `npm run db:logs`    | Follow the Postgres logs                        |
| `npm test`           | API unit + integration tests (needs the database) |

## Database

PostgreSQL 17 runs via `docker-compose.yml`:

| Setting          | Value                                             |
| ---------------- | ------------------------------------------------- |
| Database         | `TeslaB`                                        |
| User / password  | `postgres` / `postgres`                         |
| Host port        | **`55432`** (container port 5432)            |
| Connection URL   | `postgres://postgres:postgres@localhost:55432/TeslaB` |

> **Why port 55432?** This machine already has a local PostgreSQL service on `5432` and another container on `5433`. Override with `POSTGRES_PORT` in a root `.env` (see `.env.example`) and update `DATABASE_URL` in `server/.env` to match.

The server uses a `pg` connection pool (`server/src/db/pool.js`), reads `DATABASE_URL` from the environment, and falls back to the URL above when it is unset. `server/src/db/migrate.js` applies the SQL files in `server/db` in filename order, one transaction per file.

Schema (`server/db/01-schema.sql`):

```sql
CREATE TABLE users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Postgres errors are translated to HTTP responses in `server/src/middleware/errorHandler.js` — e.g. a duplicate email (`23505`) becomes `409`.

### Transport network tables (`server/db/03-transport-network.sql`)

| Table              | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `zones`            | Geographical grouping; unique `code`, `active` flag                        |
| `stops`            | Pickup/drop-off points, each in one zone; unique `code`, optional coordinates |
| `corridors`        | Named route corridors; unique `code`, `active` flag                        |
| `corridor_stops`   | Ordered corridor membership: `(corridor_id, stop_id)` PK + `position`     |
| `travel_estimates` | Directional hop estimates: minutes, kilometres, fare                      |

Design notes:

- Money (`base_fare`), distances (`estimated_distance_km`) and coordinates (`latitude`, `longitude`) use `NUMERIC`, never floating point.
- `corridor_stops` has a composite primary key `(corridor_id, stop_id)`, so a stop can appear at most once per corridor, plus `UNIQUE (corridor_id, position)`, so two stops cannot share a slot.
- The ordered stop list of a corridor lives in `corridor_stops`, never in a JSON column.
- `travel_estimates` is directional: `(from_stop_id, to_stop_id)` is unique and `from_stop_id <> to_stop_id` is enforced; `A → B` and `B → A` are separate rows and neither implies the other.
- `updated_at` is maintained by a shared `set_updated_at()` trigger; internal timestamps are never returned by the API.

## API

Base URL: `http://localhost:4000/api`

| Method   | Endpoint       | Description                                   |
| -------- | -------------- | --------------------------------------------- |
| `GET`  | `/health`    | Service status, uptime, and database probe    |
| `GET`  | `/users`     | List users                                    |
| `GET`  | `/users/:id` | Get a single user (`404` if missing)        |
| `POST` | `/users`     | Create a user — body:`{ "name", "email" }` |
| `GET`  | `/transport/zones` | List active zones                        |
| `GET`  | `/transport/stops` | List active stops, optional `?zoneCode=` |
| `GET`  | `/transport/stops/:code` | Get one stop by code               |
| `GET`  | `/transport/corridors` | List active corridors                |
| `GET`  | `/transport/corridors/:code` | Corridor with its stops ordered by `position` |
| `GET`  | `/transport/corridors/match` | Corridors serving a pickup/drop-off pair, e.g. `?pickupStopCode=banani-road-11&dropoffStopCode=mohakhali-bus-terminal` |
| `GET`  | `/transport/travel-estimates` | Direct estimate, e.g. `?fromStopCode=banani-road-11&toStopCode=gulshan-1` |

Transport endpoints are read-only and return DTOs (`server/src/serializers/transport.serializer.js`) instead of raw rows, so database column names and audit timestamps never leak into responses.

Codes are stable machine-readable values (lower-case letters, digits, `-` and `_`). Input is trimmed and lower-cased, so `?zoneCode=BANANI` works.

```json
{
  "data": [
    { "id": "…", "code": "banani-road-11", "name": "Banani Road 11", "zoneCode": "banani", "latitude": 23.7937, "longitude": 90.4043 }
  ]
}
```

Status codes are consistent across the transport endpoints:

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| `400`  | Missing, malformed, repeated or unsupported query parameter             |
| `404`  | Unknown code, or no record for the requested directional pair           |
| `409`  | The record exists but is inactive (also used for database conflicts)    |

`/health` reports `"ok"` when the database is reachable and `"degraded"` when it is not, and never fails the request:

```json
{
  "status": "ok",
  "uptime": 23.6,
  "timestamp": "2026-09-22T18:47:05.740Z",
  "database": { "status": "up", "latencyMs": 2 }
}
```

Errors use a consistent shape:

```json
{ "error": { "message": "User 99 not found" } }
```

## How the client talks to the API

- The browser requests `/api/...` on the Next.js origin; `next.config.mjs` rewrites those calls to the Express server (`API_PROXY_TARGET`, default `http://localhost:4000`). No CORS round-trip needed in the browser.
- Server components use `API_URL` from `client/.env.local` because relative URLs cannot be fetched on the server.
- Direct cross-origin calls still work — the API sends `Access-Control-Allow-Origin` for `CLIENT_ORIGIN`.

## Transport network demo data

```bash
npm run db:up        # PostgreSQL
npm run db:migrate   # create/refresh tables (idempotent)
npm run db:seed      # apply the transport demo data (idempotent)
npm test             # unit + integration tests
```

> **The seeded corridor order and every travel estimate are demo placeholders, not verified navigation data.** The MVP has no maps, geocoding, routing APIs or live traffic, so `server/src/db/seeds/transport-network.data.js` holds hand-written values: all six stops, the `northbound-demo` corridor order and the six directional estimates (minutes, kilometres, BDT fares) are invented for the demo. Edit that one file to review or change them, then re-run `npm run db:seed`.

The seed script upserts by stable `code` inside one transaction, so:

- running it repeatedly updates the existing seed rows instead of duplicating them;
- edits made in `transport-network.data.js` overwrite the previous seeded values;
- user-created zones, stops, corridors and estimates are never deleted or modified (the `northbound-demo` corridor's own stop list is owned by the seed, so it is restored to the seeded definition).

Demo trips with a seeded estimate:

| From                    | To                        |
| ----------------------- | ------------------------- |
| Banani Road 11          | Gulshan 1                 |
| Banani Road 11          | Mohakhali Bus Terminal    |
| Banani Kakoli           | Gulshan 1                 |
| Banani Kakoli           | Mohakhali Wireless Gate   |
| Gulshan 1               | Mohakhali Wireless Gate   |
| Mohakhali Wireless Gate | Mohakhali Bus Terminal    |

The reverse of each of these is deliberately *not* seeded, which is what the directional tests assert.

## Tests

```bash
npm test                        # everything
npm run test:unit --workspace server
npm run test:integration --workspace server
```

Tests use Node's built-in runner (`node --test`) — no extra dependencies. The integration suites run against the real PostgreSQL database from `DATABASE_URL`, apply `server/db/*.sql` and the seed themselves, and clean up after themselves; the database must be reachable (`npm run db:up`). Constraint tests run inside rolled-back transactions.

Coverage highlights: seed idempotency and non-deletion of user data, zone filtering, corridor stop ordering, two-way corridor matching (including the reverse-direction case with a temporary reverse corridor), rejection of unknown/inactive stops with `404`/`409`, directional estimates never matching in reverse, and the duplicate-position / duplicate-stop / identical-origin constraints.

## Next steps

- Add a real migration tool (e.g. `node-pg-migrate` or Drizzle) once the schema starts changing; the current runner re-applies idempotent SQL files.
- Add validation (e.g. `zod`) for request bodies once write endpoints exist.
- Add Playwright coverage for the client.
