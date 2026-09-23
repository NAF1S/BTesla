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
│   │   ├── 04-drop-transport-network.sql  # forward migration removing the old model
│   │   └── 05-postgis-location.sql        # PostGIS zones, points and routing graph
│   ├── prisma/
│   │   └── schema.prisma   # Prisma view of the SQL schema (hand-mapped)
│   ├── prisma7.config.ts   # Prisma CLI config (reuses src/config/env.js)
│   ├── src/
│   │   ├── index.js        # HTTP server bootstrap + graceful shutdown
│   │   ├── app.js          # Express app: middleware, routes, error handling
│   │   ├── config/env.js   # Environment configuration
│   │   ├── db/             # Prisma client, health probe, migration runner, seeder
│   │   │   └── seeds/      # location + routing graph demo data, idempotent upserts
│   │   ├── routes/         # Route definitions (index, health, users, location)
│   │   ├── controllers/    # Request handlers
│   │   ├── services/       # Business logic / queries
│   │   ├── serializers/    # Record -> response DTO mappers
│   │   ├── middleware/     # notFound, errorHandler
│   │   └── utils/          # ApiError, validation, geo (coordinate handling)
│   ├── test/               # node --test suites (unit + integration)
│   └── .env.example
├── docker-compose.yml      # PostgreSQL 17 + PostGIS 3.5 (database "TeslaB")
├── .env.example            # Optional compose overrides
├── package.json            # npm workspaces + dev/build/db scripts
└── .gitignore
```

## Getting started

```bash
npm install                        # installs workspace deps (client + server)
npm run db:up                      # start PostgreSQL 17 + PostGIS 3.5 (docker compose)
cp client/.env.local.example client/.env.local
cp server/.env.example server/.env
npm run db:migrate                 # apply server/db/*.sql (creates the PostGIS extension)
npm run db:seed                    # apply the demo zones, points and routing graph
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
| `npm run db:generate` | Regenerate the Prisma client from the schema          |
| `npm run db:migrate` | Apply `server/db/*.sql` to the database      |
| `npm run db:seed`    | Apply the location + routing graph seed (idempotent) |
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

### PostGIS prerequisite

The database image is **`postgis/postgis:17-3.5`**, not plain `postgres`. PostGIS is required because the location foundation stores real spatial types (`geography(Point, 4326)` and `geometry(LineString, 4326)`); the plain image has no PostGIS shared library, so `CREATE EXTENSION postgis` would fail on it.

```bash
npm run db:up        # pull + start the PostGIS container
npm run db:migrate   # 05-postgis-location.sql runs CREATE EXTENSION IF NOT EXISTS postgis
```

- **Already had the old container running?** Recreate it so the new image is picked up: `docker compose up -d --force-recreate db`. The `teslab-pgdata` volume is PostgreSQL 17 either way, so existing data survives.
- **Privileges.** Enabling PostGIS needs a role that may create extensions. The compose database runs as the superuser `postgres`, so this works out of the box; on a managed PostgreSQL service the extension is usually enabled from the provider's console instead, and the migration statement then becomes a no-op.
- **pgRouting is deliberately not installed.** This phase stores a graph; pathfinding is a later phase.

### ORM (Prisma)

All database access goes through **Prisma**. `server/src/db/prisma.js` exports the single client, built on the official `@prisma/adapter-pg` driver adapter (which Prisma 7 requires for PostgreSQL). Services use Prisma models rather than hand-written SQL, and error handling maps both Prisma error codes (`P2002` → 409, `P2025` → 404) and the SQLSTATEs Prisma nests inside raw-SQL errors, so the 400/404/409 contract is unchanged.

The relationship between Prisma and the SQL files is deliberate:

- **`server/db/*.sql` remains the source of truth for the physical schema.** `server/prisma/schema.prisma` was produced by introspecting it (`prisma db pull`) and maps onto the existing snake_case tables and columns with `@@map`/`@map`, so renaming a Prisma model does not rename a table.
- **`prisma migrate` is intentionally not used.** Prisma does not model `CHECK` constraints or PostGIS types, so handing it ownership of migrations would try to drop constraints such as `routing_edges_no_self_loop` and the GiST spatial indexes. Migrations stay hand-written and are applied by `npm run db:migrate`, which executes each file through Prisma, one transaction per file.
- **Spatial columns are `Unsupported("geography")` / `Unsupported("geometry")` in the Prisma schema**, because Prisma has no PostGIS types. Reading or writing a coordinate therefore goes through parameterised raw SQL (`src/services/location.service.js`, `src/db/seeds/location.seed.js`), not the Prisma client.
- `DATABASE_URL` is resolved by `server/src/config/env.js` for both the API and the Prisma CLI (`prisma7.config.ts` imports that module), so the two cannot drift apart and the API still runs with no `.env` file at all.

To check that the Prisma view still matches the live database:

```bash
cd server
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

An empty migration is the ideal result. Two things will show up as intended differences, and neither is drift to "fix":

1. the GiST spatial indexes, which Prisma cannot express on an `Unsupported` column, so it always proposes dropping them;
2. any leftover object from a database that predates the current migration files -- for example a table created by a migration that has since been removed. The database in this workspace has some of these from an earlier, abandoned branch; `npm run db:reset` gives a clean database built only from the files in `server/db`.

Like `pg_typeof()`, a few PostgreSQL internals cannot be read through Prisma raw queries; cast them (`pg_typeof(x)::text`) when you need them.

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

### PostGIS location tables (`server/db/05-postgis-location.sql`)

| Table              | Purpose                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `service_zones`    | The 15 Dhaka zones; unique `code` **and** unique `name`, `active`, `geography(Point, 4326)` centre |
| `service_points`   | Curated pickup/drop-off places; globally unique `code`, `geography(Point, 4326)` location, one zone and one routing vertex |
| `routing_vertices` | Graph nodes; unique `code`, `geometry(Point, 4326)` location                     |
| `routing_edges`    | Directed graph edges; `geometry(LineString, 4326)`, measured distance, normal/rush durations, fare weight |

Design notes:

- `code` is the stable seed key on every table, which is why a zone's display `name` can change without breaking anything that references it.
- `service_points.user_id`-style uniqueness: `(zone_id, name)` is unique, so a zone cannot list the same place twice, and `code` is globally unique.
- `service_points.routing_vertex_id` is `NOT NULL`, so a point can never exist without a graph node. The tables were created empty, so no two-phase backfill was needed.
- `routing_edges` rejects self-loops, requires at least two points of geometry, keeps `distance_meters` equal to `ST_Length(geometry::geography)`, requires `rush_hour >= normal`, and enforces that the reverse-duration columns are present **exactly** when `bidirectional` is true.
- GiST spatial indexes exist on all four geometry/geography columns; the graph also has indexes on source, target, active and code.
- `updated_at` is maintained by a shared `set_updated_at()` trigger; internal timestamps are never returned by the API.

> **Note on the coordinate range checks.** A `geography` value in SRID 4326 is *normalised* on input: casting an out-of-range point does not raise, it is silently corrected (latitude 95 becomes 85, longitude 190 becomes −170). The range checks on the geography columns therefore document what is stored rather than rejecting a bad input. Rejecting an out-of-range coordinate happens **before** the cast, in `server/src/utils/geo.js`. The range checks on `routing_vertices.location` (plain `geometry`, which does *not* normalise) are real and do fire. A test pins this behaviour.

## API

Base URL: `http://localhost:4000/api`

| Method   | Endpoint       | Description                                   |
| -------- | -------------- | --------------------------------------------- |
| `GET`  | `/health`    | Service status, uptime, and database probe    |
| `GET`  | `/users`     | List users                                    |
| `GET`  | `/users/:id` | Get a single user (`404` if missing)        |
| `POST` | `/users`     | Create a user — body:`{ "name", "email" }` |
| `GET`  | `/location/zones` | List the 15 active service zones            |
| `GET`  | `/location/points` | List active service points, optional `?zoneCode=` |
| `GET`  | `/location/points/:code` | Get one service point by code          |

The location endpoints are read-only and return DTOs (`server/src/serializers/location.serializer.js`) instead of raw rows, so database column names, routing vertices and audit timestamps never leak into responses. They are the **only** location endpoints: there is deliberately no route, distance, ETA, quote, fare, ride or matching endpoint in this phase.

Codes are stable machine-readable values (lower-case letters, digits, `-` and `_`). Input is trimmed and lower-cased, so `?zoneCode=BANANI` works.

```json
{
  "data": [
    { "id": "…", "code": "banani-road-11", "name": "Banani Road 11", "zoneCode": "banani", "latitude": 23.7937, "longitude": 90.4043 }
  ]
}
```

Status codes are consistent across the location endpoints:

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| `400`  | Missing, malformed or unsupported query parameter                        |
| `404`  | Unknown zone or point code                                              |
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

## Location and routing graph demo data

```bash
npm run db:up        # PostgreSQL 17 + PostGIS 3.5
npm run db:migrate   # create/refresh the schema, including postgis (idempotent)
npm run db:seed      # apply the demo zones, points and routing graph (idempotent)
npm test             # unit + integration tests
```

After seeding you get **15 service zones, 45 service points, 45 routing vertices and 46 routing edges** (42 bidirectional, 4 one-way).

> **Every coordinate is approximate demo data, not verified navigation data.** The MVP deliberately has no maps, geocoding, routing APIs or live traffic. `server/src/db/seeds/location.data.js` holds hand-written, neighbourhood-level coordinates for each named Dhaka location, and each edge is a straight two-point LineString between the coordinates it connects -- plausible for a demo, not a road centreline. Edit that one file to review or change any of it, then re-run `npm run db:seed`.

### ServicePoint vs RoutingVertex

They are deliberately separate models:

- a **ServicePoint** is passenger-facing: a curated place someone can later be picked up from or dropped at. It belongs to exactly one zone and has a stable, globally unique `code`.
- a **RoutingVertex** is a graph node: what a future router walks between. It carries no passenger-facing meaning.

In this seed they are one-to-one, which keeps the graph easy to reason about; the separation is what will later allow several service points to share one junction. `ServicePoint.routingVertexId` is `NOT NULL`, so a point can never exist without a vertex.

### Coordinate conventions

- Everything is **WGS84 / SRID 4326**.
- **Longitude comes first** in every PostGIS constructor: `ST_MakePoint(longitude, latitude)`. Reversing them is not an error PostGIS reports -- it silently stores a point somewhere else on the planet. Nothing in this codebase builds spatial SQL by hand: `server/src/utils/geo.js` is the single place the order is decided, and it only accepts a named `{ latitude, longitude }` pair, so the two cannot be passed positionally by mistake.
- Coordinates are validated in the application **before** the cast: latitude within ±90, longitude within ±180, and -- for this seed -- inside the generous Dhaka box defined in `geo.js`.

### RoutingEdge: distance, direction and durations

| Column | Meaning |
| ------ | ------- |
| `distanceMeters` | Measured from the geometry with `ST_Length(geometry::geography)`. Never hand-written, and a `CHECK` keeps the two in step, so an edge cannot claim a length its shape does not have. |
| `normalDurationSeconds` | Derived from the measured distance at `DEMO_SPEED_KMH.normal` (a demo 24 km/h). |
| `rushHourDurationSeconds` | Same, at the demo 14 km/h. A `CHECK` enforces `rush_hour >= normal`, so rush hour can never come out faster. |
| `fareWeight` | A relative weight for a later phase. **It is not a fare, and no money is stored on an edge.** Defaults to 1; the seed includes 1.5 and 0.75 examples. |

Direction rules:

- a directed edge always permits travel **source → target**;
- `bidirectional = true` adds the return leg, so the `reverse*DurationSeconds` columns **must** be present;
- `bidirectional = false` has no return leg, so those columns **must** be NULL.

One `CHECK` enforces both cases, and self-loop edges are rejected. The seed sets the reverse duration equal to the forward one, because a single geometry describes the pair; the columns exist so a later phase can encode genuinely asymmetric traffic.

### Graph validation

The seed validates before it commits and rolls the whole transaction back if anything is wrong, in this order: zones → vertices → points → edges → coordinate bounds → edge geometry and endpoints → graph connectivity.

Connectivity is checked with a recursive CTE: no isolated vertex, every zone touches another zone, and all vertices form one weakly connected component. That is a data-integrity check, **not** pathfinding.

To verify the stored graph yourself:

```bash
npm run test:integration --workspace server
```

### What is deliberately deferred

This phase stores and validates a graph. It does **not** implement pgRouting, Dijkstra/A*, a routing service, route quotes, distance or ETA APIs, fare calculation, ride requests, ride events, pools, pool membership, matching, driver assignment or seat reservation. Pathfinding and every routing API are a later phase.

## Tests

```bash
npm test                        # everything
npm run test:unit --workspace server
npm run test:integration --workspace server
```

Tests use Node's built-in runner (`node --test`) — no extra dependencies. The integration suites run against the real PostgreSQL database from `DATABASE_URL`, apply `server/db/*.sql` and the seed themselves, and clean up after themselves; the database must be reachable (`npm run db:up`). Constraint tests run inside rolled-back transactions.

Coverage highlights: the PostGIS extension and the real spatial column types; the GiST spatial indexes; that coordinates are stored longitude-first; `ST_DWithin` proximity answering in metres with a distant point correctly excluded; the seed totals, per-zone point counts, correct zone membership and idempotency; the coordinate bounds; and -- for the graph -- no isolated vertex, one weakly connected component, every zone linked to another, edge endpoints aligned with their vertices, edge distance matching `ST_Length`, and the direction / duration / fare-weight invariants. It also asserts that the superseded `/api/transport/*` endpoints are gone and that no routing, quote, fare or ride endpoint has appeared.

## Next steps

- Decide how schema changes are reviewed now that Prisma is in place: keep the idempotent `server/db/*.sql` files as the source of truth (the current setup, and what preserves the `CHECK` constraints and GiST indexes Prisma cannot model), or move fully to Prisma Migrate and express those another way.
- Build the routing phase on top of the stored graph: pgRouting (or an in-process algorithm), route quotes, distance/ETA and fare calculation. None of that exists yet -- the graph is stored and validated only.
- Add validation (e.g. `zod`) for request bodies once write endpoints exist.
- Add Playwright coverage for the client.
