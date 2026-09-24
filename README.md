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
│   │   ├── 04-auth.sql                    # roles, profiles, vehicles
│   │   ├── 04-drop-transport-network.sql  # forward migration removing the old location model
│   │   ├── 05-postgis-location.sql        # PostGIS zones, points and routing graph
│   │   ├── 06-pgrouting-routing.sql       # pgRouting + the integer graph identifiers
│   │   └── 07-fare-pricing.sql            # versioned fare policies + immutable quotes
│   ├── prisma/
│   │   └── schema.prisma   # Prisma view of the SQL schema (hand-mapped)
│   ├── prisma7.config.ts   # Prisma CLI config (reuses src/config/env.js)
│   ├── src/
│   │   ├── index.js        # HTTP server bootstrap + graceful shutdown
│   │   ├── app.js          # Express app: middleware, routes, error handling
│   │   ├── config/env.js   # Environment configuration
│   │   ├── db/             # Prisma client, health probe, migration runner, seeder
│   │   │   ├── seeds/      # location + routing graph + pricing + demo accounts, idempotent
│   │   │   └── seeds/graph-ids.js  # deterministic pgRouting identifiers (shared rule)
│   │   ├── routes/         # Route definitions (index, health, auth, users, location, routes, fare-quotes)
│   │   ├── controllers/    # Request handlers
│   │   ├── services/       # Business logic / queries (location, routing, fare)
│   │   ├── serializers/    # Record -> response DTO mappers
│   │   ├── middleware/     # notFound, errorHandler, auth (requireAuth, requireRole)
│   │   └── utils/          # ApiError, validation, geo, time, password, token, cookies
│   ├── test/               # node --test suites (unit + integration)
│   └── .env.example
├── docker/
│   └── db/Dockerfile       # PostgreSQL 17 + PostGIS 3.5 + pgRouting
├── docker-compose.yml      # builds docker/db/Dockerfile, database "TeslaB"
├── .env.example            # Optional compose overrides
├── package.json            # npm workspaces + dev/build/db scripts
└── .gitignore
```

## Getting started

```bash
npm install                        # installs workspace deps (client + server)
npm run db:up                      # build + start PostgreSQL 17 + PostGIS 3.5 + pgRouting
cp client/.env.local.example client/.env.local
cp server/.env.example server/.env
npm run db:migrate                 # apply server/db/*.sql (creates the postgis + pgrouting extensions)
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
| `npm run db:seed`    | Apply the location + routing graph + demo account seed (idempotent) |
| `npm run db:psql`    | Open a psql shell in the container              |
| `npm run db:logs`    | Follow the Postgres logs                        |
| `npm test`           | API unit + integration tests (needs the database) |

## Database

PostgreSQL 17 runs via `docker-compose.yml`:

| Setting         | Value                                                   |
| --------------- | ------------------------------------------------------- |
| Database        | `TeslaB`                                              |
| User / password | `postgres` / `postgres`                             |
| Host port       | **`55432`** (container port 5432)               |
| Connection URL  | `postgres://postgres:postgres@localhost:55432/TeslaB` |

> **Why port 55432?** This machine already has a local PostgreSQL service on `5432` and another container on `5433`. Override with `POSTGRES_PORT` in a root `.env` (see `.env.example`) and update `DATABASE_URL` in `server/.env` to match.

### PostGIS and pgRouting prerequisites

The database image is built from `docker/db/Dockerfile`, which starts from **`postgis/postgis:17-3.5`** and adds the **`postgresql-17-pgrouting`** package. PostGIS is required because the location foundation stores real spatial types (`geography(Point, 4326)` and `geometry(LineString, 4326)`); pgRouting is required because the route endpoint hands the graph to `pgr_dijkstra`. Neither the plain `postgres` image (no PostGIS) nor the upstream `postgis/postgis` image (no pgRouting) can run this project as-is.

```bash
npm run db:up        # build docker/db/Dockerfile and start the container
npm run db:migrate   # 05-postgis-location.sql: CREATE EXTENSION postgis
                     # 06-pgrouting-routing.sql: CREATE EXTENSION pgrouting
```

- **Rebuilding after a Dockerfile change.** `docker compose up -d --build db` (which `npm run db:up` performs) rebuilds the image when needed and recreates the container. The `teslab-pgdata` volume is PostgreSQL 17 either way, so existing data survives and nothing needs migrating.
- **Our image, not the upstream one.** `docker compose ps` should show `teslab/postgis-pgrouting:17-3.5`. If it still shows `postgis/postgis:17-3.5`, the container predates this milestone -- recreate it: `docker compose up -d --force-recreate db`. Without pgRouting, the migration fails with `could not open extension control file`.
- **Privileges.** `CREATE EXTENSION` needs a role allowed to create extensions. The compose database runs as the superuser `postgres`, so this works out of the box; on a managed PostgreSQL service the extension is usually enabled from the provider's console (or by a superuser) instead, and the migration statement then becomes a no-op.
- **Building needs network access** to `apt.postgresql.org`, which is where the pgRouting package comes from.

Verify both extensions are present:

```sql
SELECT extname
FROM pg_extension
WHERE extname IN ('postgis', 'pgrouting');
```

```bash
npm run db:psql   # then paste the query
```

Expected: two rows, `postgis` and `pgrouting` (this project is built against PostGIS 3.5 and pgRouting 3.8).

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

| Method   | Endpoint                     | Description                                                                          |
| -------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `GET`  | `/health`                  | Service status, uptime, and database probe                                            |
| `GET`  | `/users`                   | List users                                                                            |
| `GET`  | `/users/:id`               | Get a single user (`404` if missing)                                                |
| `POST` | `/users`                   | Create a user (**ADMIN only**) — body: `{ "name", "email" }`                |
| `POST` | `/auth/register`           | Sign up as PASSENGER or DRIVER; signs in — body: `{ "name", "email", "password", "role"? }` |
| `POST` | `/auth/login`              | Log in; sets the HttpOnly auth cookie — body: `{ "email", "password" }`      |
| `GET`  | `/auth/me`                 | Current user (requires authentication)                                                |
| `POST` | `/auth/logout`             | Clear the auth cookie (safe to retry)                                                 |
| `GET`  | `/location/zones`          | List the 15 active service zones                                                      |
| `GET`  | `/location/points`         | List active service points, optional `?zoneCode=`                                   |
| `GET`  | `/location/points/:code`   | Get one service point by code                                                         |
| `POST` | `/routes/estimate`         | Estimate a route between two service points (**requires authentication**) -- see [Routing](#routing) |
| `POST` | `/fare-quotes`             | Quote a solo fare in BDT (**requires authentication**) -- see [Fare quotes](#fare-quotes) |

The location endpoints are read-only and return DTOs (`server/src/serializers/location.serializer.js`) instead of raw rows, so database column names, routing vertices and audit timestamps never leak into responses. `/location` is only ever about places: there is deliberately no route, distance, ETA, quote or fare endpoint under it, and none should be added. Route estimation lives at `/routes/estimate` instead.

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
| `401`  | Credentials rejected, or no valid authentication (auth endpoints)        |
| `403`  | Authenticated, but not permitted for this role                           |
| `404`  | Unknown zone or point code                                               |
| `409`  | The record exists but is inactive (also used for database conflicts)    |
| `422`  | The request is well-formed but has no answer (an unreachable destination) |

Both write-less calculation endpoints are authenticated, and neither is wrapped in a `data` envelope: a route estimate and a fare quote are the answer, not a list of answers. The location endpoints are the only ones that return `{ "data": [...] }`.
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

## Authentication

Authentication is a **signed JWT carried in an HttpOnly cookie**. There is no server-side session store, and nothing is ever put in `localStorage`.

### Why this design

- The browser only ever talks to the same origin — `next.config.mjs` proxies `/api/*` to Express — so `SameSite=Lax` is sufficient and no CSRF token is needed.
- The cookie is `HttpOnly`, so JavaScript (and therefore any XSS payload) cannot read the token.
- The token payload carries **only the user id**. It deliberately never carries the role or the profile, because nothing in the token is trusted for authorization: `requireAuth` re-loads the user from the database on every request. A deactivated account, a deleted account or a changed role therefore takes effect on the very next request instead of at token expiry.

### Signing up

`POST /auth/register` creates an account and signs it in immediately, using the same HttpOnly cookie as login. It returns `201`.

| Field        | Required | Notes                                                                       |
| ------------ | -------- | --------------------------------------------------------------------------- |
| `name`     | yes      | Trimmed; must not be blank                                                  |
| `email`    | yes      | The login identifier; trimmed and lower-cased before storage                |
| `password` | yes      | At least 8 characters, at most 72 bytes (bcrypt's input limit)              |
| `role`     | no       | `PASSENGER` (default) or `DRIVER`. **`ADMIN` is not accepted.** |

- A `PASSENGER` is created with a passenger profile; a `DRIVER` is created with a driver profile that starts `OFFLINE` and has no vehicle, so a self-registered driver cannot be matched until a vehicle exists.
- **`ADMIN` can never be self-selected.** It is not an accepted value for `role`, so a client cannot promote itself by adding a field to the body — the attempt is simply a `400`. Admins are created by an existing admin through `POST /api/users`.
- An email that is already registered returns `409`, including a case variant, because the identifier is normalised before it is stored.

```bash
curl -i -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"name":"Ayesha","email":"ayesha@example.com","password":"BrandNewPass1!","role":"DRIVER"}' \
  http://localhost:4000/api/auth/register
```

> **Known trade-off.** Because sign-up reports that an email is already registered, this endpoint can be used to probe whether an account exists. Login deliberately does not leak that. The usual fix is to accept the request and confirm by email instead, which needs the email-verification flow that is not built yet (see Next steps).

### Demo accounts

Seeded by `npm run db:seed`. **Development/demo only — never seed these in production.**

| Actor  | Email                  | Role          | Profile / vehicle                         |
| ------ | ---------------------- | ------------- | ----------------------------------------- |
| Nusrat | `nusrat@example.com` | `PASSENGER` | Passenger profile                         |
| Rafiq  | `rafiq@example.com`  | `PASSENGER` | Passenger profile                         |
| Shirin | `shirin@example.com` | `PASSENGER` | Passenger profile                         |
| Jashim | `jashim@example.com` | `DRIVER`    | Driver profile + vehicle Bullet (3 seats) |

The demo password is **not** stored in the repository. Every demo account is given the value of `DEMO_SEED_PASSWORD` (default `DemoPass123!`), hashed with bcrypt before it reaches the database. To change it, set `DEMO_SEED_PASSWORD` in `server/.env` and re-run the seed.

> **Production warning.** The seeder refuses to run when `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true`, and even then it requires `DEMO_SEED_PASSWORD` to be set explicitly. The server separately refuses to start in production without `JWT_SECRET`.

### Example requests

```bash
# Log in. The token is returned only as a Set-Cookie, never in the body.
curl -i -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"nusrat@example.com","password":"DemoPass123!"}' \
  http://localhost:4000/api/auth/login

# Current user
curl -b cookies.txt http://localhost:4000/api/auth/me

# Log out (safe to retry)
curl -i -b cookies.txt -X POST http://localhost:4000/api/auth/logout
```

Successful login and current-user responses:

```json
{
  "user": {
    "id": "…",
    "name": "Nusrat",
    "role": "PASSENGER",
    "active": true,
    "passengerProfile": { "id": "…" }
  }
}
```

Jashim's response carries `driverProfile` instead, including the active vehicle summary:

```json
{
  "user": {
    "id": "…",
    "name": "Jashim",
    "role": "DRIVER",
    "active": true,
    "driverProfile": {
      "id": "…",
      "status": "OFFLINE",
      "vehicles": [{ "id": "…", "name": "Bullet", "seatCapacity": 3 }]
    }
  }
}
```

Only the profile belonging to the role is returned: `passengerProfile` for a passenger, `driverProfile` for a driver, and neither for an admin. `passwordHash` and the audit timestamps are never part of the response — `server/src/serializers/user.serializer.js` builds its output as a whitelist, so a new column cannot leak by accident.

### Authentication errors

| Status  | Meaning                                                        |
| ------- | -------------------------------------------------------------- |
| `400` | Missing or malformed credentials, or an unsupported body field |
| `401` | Credentials rejected, or no valid authentication               |
| `403` | Authenticated, but not permitted for this role                 |

Every rejected login returns the same `401` with the same message, so a caller cannot tell an unknown account from a wrong password. Validation errors never echo the submitted password.

### Authorization

`server/src/middleware/auth.js` is the reusable foundation:

- `requireAuth` — loads the user from the database and rejects inactive or deleted accounts.
- `requireRole('ADMIN')` — role guard; must be mounted after `requireAuth`.
- `currentUser(req)` — the authenticated user attached to the request.

`POST /api/users` is gated with `requireRole(Role.ADMIN)`. That is both a real use of the guard and what stops a client from choosing `ADMIN` when creating an account. `POST /api/routes/estimate` uses `requireAuth` on its own, because estimating a route needs a session but not a particular role. The read endpoints (`GET /api/users`, `GET /api/location/*`) are still public so the Next.js demo page keeps working; tightening them is a follow-up once the client can send the cookie.

Authorization is always decided on the server from the database record. Hiding routes in the front end is not authorization.

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
| `fareWeight` | A relative weight that scales the per-kilometre part of an edge's fare -- one edge, in both directions. **It is not a fare, and no money is stored on an edge.** Defaults to 1; the seed includes 1.5 and 0.75 examples. See [Edge fare weight](#edge-fare-weight). |

Direction rules:

- a directed edge always permits travel **source → target**;
- `bidirectional = true` adds the return leg, so the `reverse*DurationSeconds` columns **must** be present;
- `bidirectional = false` has no return leg, so those columns **must** be NULL.

One `CHECK` enforces both cases, and self-loop edges are rejected. The seed sets the reverse duration equal to the forward one, because a single geometry describes the pair; the columns exist so a later phase can encode genuinely asymmetric traffic.

### Graph validation

The seed validates before it commits and rolls the whole transaction back if anything is wrong, in this order: zones → vertices → points → edges → coordinate bounds → edge geometry and endpoints → graph connectivity.

Connectivity is checked with a recursive CTE: no isolated vertex, every zone touches another zone, and all vertices form one weakly connected component. That is a data-integrity check, **not** pathfinding -- the router is a separate concern, see [Routing](#routing).

To verify the stored graph yourself:

```bash
npm run test:integration --workspace server
```

### What is deliberately deferred

This phase stores and validates a graph, and the milestones since calculate routes over it and price them. What is deliberately **not** implemented is everything after a price: ride requests, ride events, passenger ownership, request idempotency, pools, pool membership, shared or discounted fares, ride matching, seat reservation, driver assignment, payments, wallets, demand-based surge pricing and live traffic. See [Routing](#routing) and [Fare quotes](#fare-quotes).

## Routing

Point-to-point route estimation between two seeded service points, using **pgRouting**'s `pgr_dijkstra` over the stored graph.

```bash
docker compose up -d --build db                      # image with PostGIS + pgRouting
npm run db:migrate                                   # 06-pgrouting-routing.sql
npm run db:seed                                      # the graph the router walks

# The endpoint requires a session, so sign in first and keep the cookie.
curl -s -c cookies.txt -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"nusrat@example.com","password":"DemoPass123!"}'

curl -s -b cookies.txt -X POST http://localhost:4000/api/routes/estimate \
  -H 'Content-Type: application/json' \
  -d '{"originServicePointCode":"banani-road-11","destinationServicePointCode":"mohakhali-bus-terminal","departureAt":"2026-09-24T08:41:00+06:00"}'
```

### Migration

`server/db/06-pgrouting-routing.sql` is a **forward migration**: it is applied by `npm run db:migrate` on top of the existing files and does not rewrite any of them. It:

1. runs `CREATE EXTENSION IF NOT EXISTS pgrouting`;
2. adds `routing_vertices.graph_node_id` and `routing_edges.graph_edge_id` (see below);
3. backfills them for a graph that was already seeded;
4. adds the uniqueness, positivity and immutability enforced on them.

### Database and container requirements

PostgreSQL 17 with **both** PostGIS 3.5 and pgRouting 3.8. The container is built from `docker/db/Dockerfile`; see [PostGIS and pgRouting prerequisites](#postgis-and-pgrouting-prerequisites) for the verification query and the privileges `CREATE EXTENSION` needs. A plain `postgres` image cannot run this project: the migration fails without the extension control file.

### Identifier strategy

pgRouting requires **integer** graph identifiers. This project keys its tables on UUIDs, so each vertex and edge carries an additional immutable identifier *alongside* its UUID primary key:

| Column | Type | Purpose |
| ------ | ---- | ------- |
| `routing_vertices.graph_node_id` | `bigint`, unique, non-null | `source` / `target` in pgRouting's edge query |
| `routing_edges.graph_edge_id` | `bigint`, unique, non-null | `id` in that query, and the value pgRouting returns in its `edge` column |

- **Nothing was replaced.** The UUID `id` remains the primary key and the target of every foreign key; `service_points.routing_vertex_id` still points at a UUID. The integers are internal and are never returned by the API -- a client refers to an edge by its stable `code`.
- **The values are deterministic.** Both the migration and the seeder rank codes ascending in byte order (`COLLATE "C"` in SQL, `Array#sort` in `server/src/db/seeds/graph-ids.js`). Because the rule is derived from the codes rather than from insertion order, a database built from scratch and one migrated from the location phase end up with **identical** identifiers. Two unit tests and an integration test pin that agreement.
- **They are immutable.** `prevent_graph_identifier_change()` rejects any `UPDATE` of either column. A route result is a list of edge identifiers, so an identifier that could be reassigned would silently repoint an existing route.
- **They are assigned automatically if you do not name one.** A sequence supplies the next value for a hand-written insert (a fixture, say), and both the migration and the seeder keep that sequence above the highest identifier in use.

### Endpoint

`POST /api/routes/estimate` — **requires authentication.**

The existing `requireAuth` guard is mounted on this route, so the request must carry the same HttpOnly auth cookie `POST /auth/login` / `POST /auth/register` issued:

- **No valid session is a `401`**, including a malformed, tampered or expired token, and an account that was deactivated or deleted after its token was issued. The guard re-loads the user from the database on every request, so the token alone is never enough.
- **Any active role may call it.** A passenger planning a trip and a driver checking a pickup are equally entitled to estimate a route, so there is no `requireRole` here.
- The caller's identity is **not an input to the calculation**: nothing is written, and the response is identical for every authenticated user.
- It is the only endpoint in this milestone that requires a session. The location reads (`/location/*`) stay public, and no new authentication mechanism was built — this reuses `server/src/middleware/auth.js`.

| Field | Required | Notes |
| ----- | -------- | ----- |
| `originServicePointCode` | yes | A `service_points.code`; trimmed and lower-cased |
| `destinationServicePointCode` | yes | A different `service_points.code` |
| `departureAt` | no | ISO 8601 **with an explicit offset**; defaults to now |

Request:

```json
{
  "originServicePointCode": "banani-road-11",
  "destinationServicePointCode": "mohakhali-bus-terminal",
  "departureAt": "2026-09-24T08:41:00+06:00"
}
```

Response `200`:

```json
{
  "origin": { "code": "banani-road-11", "name": "Banani Road 11" },
  "destination": { "code": "mohakhali-bus-terminal", "name": "Mohakhali Bus Terminal" },
  "departureAt": "2026-09-24T02:41:00.000Z",
  "estimatedArrivalAt": "2026-09-24T02:50:29.000Z",
  "trafficProfile": "RUSH_HOUR",
  "distanceMeters": 2214,
  "distanceKilometers": 2.214,
  "durationSeconds": 569,
  "durationMinutes": 9,
  "geometry": {
    "type": "LineString",
    "coordinates": [[90.4043, 23.7937], [90.4006, 23.774]]
  },
  "legs": [
    {
      "sequence": 1,
      "edgeCode": "edge-mohakhali-bus-terminal-to-banani-road-11",
      "direction": "BACKWARD",
      "distanceMeters": 2214,
      "durationSeconds": 569
    }
  ]
}
```

That is a real response from the seeded demo graph, not an illustration. Every field is built by `server/src/serializers/route.serializer.js`, which is a whitelist -- no graph identifier, no audit timestamp and **no fare field** can leak into it.

Notes on the numbers:

- `distanceMeters` is the **sum of the traversed edges' measured distances**, rounded per edge. It is network distance along the graph, never a straight-line distance.
- `distanceKilometers` is the same number in kilometres, rounded to the metre; `durationMinutes` is `durationSeconds` rounded to a whole minute.
- `estimatedArrivalAt` is exactly `departureAt + durationSeconds`. Both timestamps are UTC ISO 8601.
- `legs` are in travel order (`sequence` 1, 2, ...), one per traversed edge, and `direction` says whether that edge was followed along its stored `source → target` (`FORWARD`) or against it (`BACKWARD`).
- `geometry` is a single GeoJSON `LineString` in travel order, in `[longitude, latitude]` (the GeoJSON convention, which happens to match PostGIS's). Edges traversed backwards have their geometry reversed, so the line reads as the journey was made. The legs are joined in path order rather than by asking PostGIS to merge an unordered set, which is why a route with backward legs is still one `LineString`.

### Traffic profiles

An edge carries a normal duration and a rush-hour duration. The endpoint picks **one** profile for the whole route:

| Profile | When | Cost used |
| ------- | ---- | --------- |
| `NORMAL` | outside the rush-hour windows | `normal_duration_seconds` forward, `reverse_normal_duration_seconds` backward |
| `RUSH_HOUR` | inside them | `rush_hour_duration_seconds` forward, `reverse_rush_hour_duration_seconds` backward |

- The windows are **configurable** with `RUSH_HOUR_WINDOWS` (see `server/.env.example`). The default is `07:30-10:30,16:30-20:00`.
- A window is **half-open**: the start minute is rush hour, the end minute is not. With the default, 07:29 is normal, 07:30 and 10:29 are rush hour, and 10:30 is normal again.
- A window whose end is not after its start **wraps past midnight**, so `22:00-02:00` works.
- A malformed value stops the process at start-up instead of quietly estimating every route with the wrong costs.
- **A client cannot choose a profile.** Sending `trafficProfile` in the body is a `400`, not a silent override; the profile is derived on the server from the departure instant.

#### Asia/Dhaka

- `departureAt` is an instant; the response always returns UTC. Asia/Dhaka is used for exactly one thing: deciding whether *that instant* is rush hour locally, via `Intl.DateTimeFormat` (not a hard-coded `+06:00`), so a zone rule change cannot silently produce wrong answers.
- Because the decision is made on the instant, `2026-09-24T08:41:00+06:00` and `2026-09-24T02:41:00Z` produce byte-identical responses.
- A timestamp **without an offset** (`2026-09-24T08:41`) is a `400`: it does not name an instant, and guessing the zone is how a rush-hour route gets estimated with normal costs.
- **Known limitation.** The profile is chosen once, from the departure instant, and applies to the whole journey. A trip that departs at 10:29 is estimated entirely with rush-hour costs even though it crosses 10:30, and time-dependent profile changes *during* a journey are not supported. Supporting them needs per-second cost functions and a time-dependent router.

### Directed and one-way edges

- An edge always permits travel `source → target`. `bidirectional = true` adds the return leg.
- For a one-way edge the edge query returns `reverse_cost = -1`, which is how pgRouting is told the edge is *not traversable* in reverse -- it is not merely expensive. The seed contains four one-way edges, and `farmgate → khamarbari` is the interesting one: it makes Khamarbari and Indira Road reachable but with no way back out, so `khamarbari → banani-road-11` is a legitimate **`422`**, not an error.
- A detour is preferred to an illegal reversal. `shapla-chattar → sadarghat` is one-way; the reverse journey (`sadarghat → shapla-chattar`) therefore routes the long way round via `jatrabari-intersection` instead of using the direct edge backwards. Two integration tests pin this: the returned route never contains the one-way edge traversed backwards, and enabling the reverse leg temporarily makes the router switch to the direct edge.
- Routing uses **duration** as cost. Distance and `fare_weight` are never used as a routing cost: the path is chosen on duration alone, which is exactly why a fare weight can change a price without changing a route. Pricing itself belongs to [Fare quotes](#fare-quotes), and the route responses carry no fare field.

### Errors

| Status | When |
| ------ | ---- |
| `400` | Missing origin/destination, malformed code, malformed or offset-less `departureAt`, identical origin and destination, unsupported body field |
| `401` | No valid session: no cookie, a malformed/tampered/expired token, or an account that is inactive or deleted |
| `404` | Either service point code is unknown |
| `409` | Either service point is inactive, or its routing vertex is |
| `422` | Both points are valid and active, but no route exists (the graph is only weakly connected) |
| `500` | The graph or pgRouting failed -- always a stable `Route calculation failed` message |

```json
{ "error": { "message": "Service point \"nowhere\" was not found" } }
```

No raw SQL, driver message or stack trace is ever returned: internal failures are logged server-side and replaced with one fixed message.

### Security

- The two ServicePoint codes are validated against the project's code format and **bound as parameters**; they are never concatenated into SQL.
- pgRouting takes its edge set as SQL *text*, which is the obvious injection surface here. Nothing is interpolated into it: `server/src/services/routing.service.js` holds two complete, fixed, application-controlled edge queries -- one per profile -- and picks between them. Even the profile name never reaches the SQL, which is why a client cannot influence it.
- Graph identifiers are never accepted from a client. The identifiers passed to `pgr_dijkstra` come from the database (via the service points) and from pgRouting's own output, and are re-validated as positive integers.
- The endpoint **requires authentication** via the existing `requireAuth` middleware, which re-loads the active user from the database rather than trusting the token. Any active role may call it. Authentication runs *before* the body is validated, so an anonymous caller cannot probe the request contract, and the guard is mounted on the route rather than on the router, so an unknown `/api/routes/*` path still answers `404` instead of revealing that something is behind a guard. No new authentication system was built.
- The routing queries run with a PostgreSQL `statement_timeout` (default 5 s, `ROUTING_STATEMENT_TIMEOUT_MS`) scoped to a short transaction, so a runaway query cannot hold a connection indefinitely.

### Performance

The demo graph is tiny, but the shape is what a larger one would need: only **active** edges (and vertices) are considered; the path's edges are loaded in **one** query and put back into path order using the sequence pgRouting returned, so there is never a query per leg; and the unique index on each graph identifier is what that lookup uses, while `source_vertex_id`, `target_vertex_id` and `active` keep their indexes from `05-postgis-location.sql`. No caching is added: nothing has been measured yet.

### Approximate demo data

**Every coordinate, distance and duration in this graph is approximate demo data, not verified navigation data.** Edges are straight two-point lines between neighbourhood-level coordinates, and durations are derived from those lengths at demo speeds (24 km/h normal, 14 km/h rush hour). The route the endpoint returns is therefore a plausible-looking answer over a hand-written toy graph -- not a road-following route, and not a travel-time promise. There are no maps, no geocoding and no external routing or live-traffic APIs anywhere in this milestone.

### Routing tests

```bash
npm test                                   # everything (unit + integration)
npm run test:unit --workspace server        # no database needed
npm run test:integration --workspace server # needs `npm run db:up`
```

The routing coverage is deliberately explicit about the parts that are easy to get quietly wrong: that pgRouting is installed and callable; that the endpoint requires a session (401 without a cookie, with a tampered one, and for an account deactivated after its token was issued) while any active role is answered; the identifier strategy (UUID keys kept, integers added, the seeder's rule matching the database's, immutability enforced); Banani Road 11 → Mohakhali Bus Terminal; legs in path order and consecutive legs connected at a shared node; forward traversal using the forward duration and backward traversal using the reverse duration; a one-way edge refusing reverse traversal, and the detour that replaces it; network distance and duration equalling the sum over traversed edges only; rush-hour versus normal costs, both from fixed instants rather than the clock; arrival = departure + duration; geometry in path order, reversed for backward legs; every documented error case; and that no fare, request, pool or matching table or endpoint appeared.

## Fare quotes

Solo fare quoting: **how much** the journey from [Routing](#routing) costs, in **BDT**, under a **versioned** pricing policy, stored as an **immutable** quote.

```bash
docker compose up -d --build db                # PostGIS + pgRouting image
npm run db:migrate                             # 07-fare-pricing.sql
npm run db:seed                                # the demo policy (dhaka-solo v1)

# Authenticated, like route estimation: sign in first.
curl -s -c cookies.txt -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"nusrat@example.com","password":"DemoPass123!"}'

curl -s -b cookies.txt -X POST http://localhost:4000/api/fare-quotes \
  -H 'Content-Type: application/json' \
  -d '{"originServicePointCode":"banani-road-11","destinationServicePointCode":"mohakhali-bus-terminal","departureAt":"2026-09-24T08:41:00+06:00"}'
```

### Money: exact decimals, never floats

- **Storage** is PostgreSQL `numeric` everywhere (`fare_policies` at `numeric(12,4)`, `fare_quotes` at `numeric(14,6)`). There is no `float`/`double precision` column anywhere near a price, because binary floating point cannot represent `0.10` and a fare built from it is a fare nobody can reproduce.
- **Arithmetic** is decimal.js, reached through `Prisma.Decimal`, which the project already depends on via Prisma -- no new dependency was added. Every value is a `Decimal` or a decimal *string*; a JavaScript `number` is **refused** by the calculator rather than converted, because by the time a price is a `number` the precision is already gone.
- **Transport** is decimal **strings**: `"166.28"`, `"1.10"`, `"2.214"`. `JSON.parse` of a bare `166.28` produces a float, so returning numbers would undo the exactness at the last step. A client that needs to add or compare these should parse them as decimals.
- The seed file writes money as strings too (`baseFare: '40.00'`), so what the seed says is literally what the database stores.

### The fare formula

```text
edgeDistanceKilometers = edgeDistanceMeters / 1000
edgeDistanceCharge     = edgeDistanceKilometers × perKilometerRate × edgeFareWeight   [rounded]

distanceFare           = sum(edgeDistanceCharge)
timeFare               = (durationSeconds / 60) × perMinuteRate                       [rounded]
preTrafficSubtotal     = baseFare + distanceFare + timeFare
trafficMultiplier      = RUSH_HOUR ? rushHourMultiplier : normalTrafficMultiplier
trafficAdjustment      = preTrafficSubtotal × (trafficMultiplier - 1)                 [rounded]
finalFare              = max(minimumFare, preTrafficSubtotal + trafficAdjustment)
```

Every input comes from the server: the legs, distance and duration from the routing service, the policy from the database. A client cannot send a distance, a duration, a fare weight, a traffic profile or a policy version -- each of those is a `400` (see [the request](#fare-quote-request)).

### Rounding

Rounding is **HALF_UP to the policy's `roundingScale`** (2 decimals by default), and it happens at exactly two kinds of boundary, both marked `[rounded]` above:

1. when a money figure is produced -- each edge's distance charge, the time fare, and the traffic adjustment;
2. when a configured **amount** enters the calculation -- `baseFare` and `minimumFare` are expressed at `roundingScale`.

Nothing else is rounded and nothing is rounded twice. **Rates are not rounded**: a rate is a price per unit, not an amount, so it keeps its configured precision. The result is the property that makes a quote checkable -- every figure is an amount at `roundingScale`, so *the displayed components always add up to the displayed total*, and the database enforces it (`fare_quotes_subtotal_consistent`, `fare_quotes_total_consistent`).

Note that `durationMinutes` is a **presentation** value (2 decimals). The time fare is calculated from the exact duration, so `569 s` costs `569/60 × 2.00 = 18.9666… → 18.97`, not `9.48 × 2.00 = 18.96`.

### Fare-policy fields

| Field | Meaning |
| ----- | ------- |
| `code`, `version` | The identity of a policy version. Unique together. `dhaka-solo` v1 is the seeded demo policy. |
| `name` | Human label. |
| `currency` | `BDT`, and only BDT: a database constraint and the calculator both refuse anything else. |
| `baseFare` | Flat charge for any journey. Added once. |
| `perKilometerRate` | BDT per network kilometre, applied per edge. |
| `perMinuteRate` | BDT per routed minute. |
| `minimumFare` | Floor for the final fare. |
| `normalTrafficMultiplier` | Traffic multiplier outside the rush-hour windows. `1.0000` in the seed, so off-peak is the baseline. |
| `rushHourMultiplier` | Traffic multiplier inside them. `1.1000` in the seed. |
| `quoteTtlSeconds` | How long a quote stays usable: `expiresAt = createdAt + quoteTtlSeconds`. |
| `roundingScale` | Decimal places every money figure is rounded to, `0`-`6`. |
| `active` | Whether the version may be selected at all. |
| `effectiveFrom` / `effectiveTo` | The window the version prices. Half-open: `effectiveTo` is nullable for an open-ended policy. |

All monetary rates must be non-negative, multipliers must be positive, the TTL must be positive, the scale must be 0-6, and the window must end after it starts -- each enforced by a `CHECK` constraint, not by a code path remembering to check.

### Pricing versioning

- A policy is identified by **`(code, version)`**. `dhaka-solo` v1 and v2 are different prices, not a correction to one price.
- **The version is chosen by the server**, from configuration (`FARE_PRICING_CODE`, default `dhaka-solo`) and the departure instant -- never from the request. The one documented rule is: *the highest version of the configured code that is `active` and whose window contains `departureAt`* (`effectiveFrom <= departureAt`, and `effectiveTo` is null or `> departureAt`). Departure, not creation, because the price that applies is the one for the journey being quoted.
- The window is **half-open**, so the usual upgrade is: give v2 a later `effectiveFrom` and set v1's `effectiveTo` to the same instant. There is then no gap and no overlap at the handover.
- **A version that has been quoted is frozen.** A trigger refuses any `UPDATE` of `code`, `version`, `currency`, the four amounts, either multiplier or `roundingScale` on a policy that quotes reference. Changing a live price means inserting the next version. Operational fields -- `name`, `active`, `effectiveFrom/To`, `quoteTtlSeconds` -- stay editable, because retiring or renaming a version changes no historical number.
- **The seeder never rewrites history.** It creates a version that does not exist, updates one that no quote references (so iterating on demo rates before anybody is quoted works), and leaves a quoted version completely alone.
- A departure instant with **no** effective policy, or with **more than one** (an overlapping configuration), is a server-side configuration failure: a controlled `500`, never a fallback rate. There is deliberately no default rate to substitute.

### Edge fare weight

`routing_edges.fare_weight` (seeded at 1.0, with 1.5 and 0.75 examples) multiplies the **distance charge** of the edge it belongs to. It is not an amount and not a rate: it scales the per-kilometre component of that one edge.

- It affects the **distance fare only** -- never the time fare, never the base fare, never the minimum fare.
- It **cannot change which route is taken**. The router optimises duration; fare weight is read after the path is chosen. An integration test sets a weight to 999 and asserts the route is byte-identical while the fare rises.
- A missing, zero, negative or non-finite weight is a **graph-data error**: a controlled `500`, never a silent default of 1.0, because quietly pricing an unweighted edge is how a fare becomes wrong without anyone noticing.
- One weight applies to the edge in both directions; directional weights are not implemented.

### Traffic multipliers

The route's traffic profile (`NORMAL` or `RUSH_HOUR`, decided server-side from the departure instant in Asia/Dhaka -- see [Traffic profiles](#traffic-profiles)) selects the multiplier, and it is applied **exactly once**, as a recorded adjustment on top of the subtotal:

```text
trafficAdjustment = round(preTrafficSubtotal × (multiplier - 1))
finalFare         = max(minimumFare, preTrafficSubtotal + trafficAdjustment)
```

It is never applied to the subtotal a second time and never to an already-adjusted total. `quoteTtlSeconds` is not a multiplier, and there is no demand-based surge pricing: the only traffic adjustment is this one.

### Minimum fare

`finalFare = max(minimumFare, adjustedSubtotal)`. The floor is applied **last**, after the traffic multiplier, and the quote records both the floor that applied and whether it actually won:

- `minimumFareApplied` is `true` only when the floor was *above* the calculated fare. A fare exactly equal to the minimum is the calculated fare, not a floor being imposed.
- The components are still stored when the floor applies, so the quote still explains what the journey actually cost to compute.

### Quote expiration

- `expiresAt = createdAt + quoteTtlSeconds`, both timestamps derived from one instant, so the difference is exactly the TTL (`300 s` in the seed) with no drift between two clocks.
- **Expiry does not delete anything.** An expired quote stays stored: it is evidence of what was offered, and a later `RideRequest` will need to point at it. Nothing in this phase prunes quotes, and the table has an index on `expires_at` for a future sweep.
- Expiry is a deadline a consumer must respect. `isQuoteExpired(quote, at)` in `server/src/services/fare.calculator.js` is the one definition, and a quote is expired **at** its expiry instant.

### FareQuote: immutable and auditable

A quote is written once and never updated -- a trigger refuses any `UPDATE`, and no service function exists that could try. It records:

- the two service points (as foreign keys), the departure and estimated arrival instants, the traffic profile, the distance and duration the fare was calculated over;
- the **exact policy version** used, by id and by `pricingCode`/`pricingVersion`, plus the currency;
- every component of the formula: `baseFare`, `distanceFare`, `timeFare`, `preTrafficSubtotal`, `trafficMultiplier`, `trafficAdjustment`, `minimumFare`, `minimumFareApplied`, `finalFare`;
- a **`routeSnapshot`**: the ordered legs with their edge code, traversal direction, distance, selected duration, fare weight and the distance charge that weight produced, plus the merged geometry and the endpoints. This is the audit trail, stored rather than recomputed later against a graph that may since have changed;
- a **`fareBreakdown`**: the components, the rates that produced them, the quantities they were applied to, and the rounding rule (`{ scale, mode }`).

Because the breakdown is stored with the quote, a quote stays reproducible after its policy is superseded -- and the stored arithmetic is self-checking: three `CHECK` constraints refuse a row whose subtotal, total or minimum-fare flag does not agree with its own numbers.

### Fare-quote request

`POST /api/fare-quotes` — **requires authentication**, like `/routes/estimate`. Any active role may ask. The caller's identity is not part of the quote and is **not stored**: this phase has no passenger ownership, and a later `RideRequest` -- not the quote -- is what will reference a passenger.

| Field | Required | Notes |
| ----- | -------- | ----- |
| `originServicePointCode` | yes | A `service_points.code`; trimmed and lower-cased |
| `destinationServicePointCode` | yes | A different `service_points.code` |
| `departureAt` | no | ISO 8601 **with an explicit offset**; defaults to now. Decides both the traffic profile and which policy version applies |

Sending anything else -- `distanceMeters`, `durationSeconds`, `finalFare`, `pricingVersion`, `pricingCode`, `trafficMultiplier`, `currency` -- is a `400`, not a silently ignored field.

### Fare-quote response

`201 Created`: a quote is a stored resource with an id, like a created account.

```json
{
  "quoteId": "cc1116ae-0a82-4d4c-9d06-92d8084c26e4",
  "origin": { "code": "banani-road-11", "name": "Banani Road 11" },
  "destination": { "code": "mohakhali-bus-terminal", "name": "Mohakhali Bus Terminal" },
  "departureAt": "2026-09-24T02:41:00.000Z",
  "estimatedArrivalAt": "2026-09-24T02:50:29.000Z",
  "trafficProfile": "RUSH_HOUR",
  "route": {
    "distanceMeters": 2214,
    "distanceKilometers": "2.214",
    "durationSeconds": 569,
    "durationMinutes": "9.48"
  },
  "fare": {
    "currency": "BDT",
    "pricingCode": "dhaka-solo",
    "pricingVersion": 1,
    "baseFare": "40.00",
    "distanceFare": "59.78",
    "timeFare": "18.97",
    "preTrafficSubtotal": "118.75",
    "trafficMultiplier": "1.10",
    "trafficAdjustment": "11.88",
    "minimumFareApplied": false,
    "finalFare": "130.63"
  },
  "expiresAt": "2026-09-24T02:46:00.000Z"
}
```

That is a real response from the seeded demo graph. Check it by hand: the traversed edge is 2214 m and weighted 1.5, so `2.214 × 18.00 × 1.5 = 59.778 → 59.78`; the rush-hour duration is 569 s, so `569/60 × 2.00 = 18.9666… → 18.97`; the subtotal is `40.00 + 59.78 + 18.97 = 118.75`; the peak adjustment is `118.75 × 0.10 = 11.875 → 11.88`; and the final fare is `118.75 + 11.88 = 130.63`. The same journey at 12:00 costs `110.85`, because the duration drops to 332 s and the multiplier is `1.00`.

Error responses use the project's standard shape:

```json
{ "error": { "message": "Unsupported body field(s): finalFare. Supported: originServicePointCode, destinationServicePointCode, departureAt" } }
```

| Status | When |
| ------ | ---- |
| `201` | A quote was created and stored |
| `400` | Missing origin/destination, malformed code, malformed or offset-less `departureAt`, identical endpoints, unsupported body field |
| `401` | No valid session |
| `404` | Either service point code is unknown |
| `409` | Either service point is inactive, or its routing vertex is |
| `422` | No route exists between two valid, active points |
| `500` | The routing algorithm, the policy configuration, the fare calculation or the quote write failed -- always a stable message, never raw SQL or a pricing dump |

### Commands

```bash
npm run db:migrate                 # applies 07-fare-pricing.sql (idempotent)
npm run db:seed                    # seeds the demo policy; safe to re-run
npm test                           # unit + integration
npm run test:unit --workspace server        # calculator and serializer, no database
npm run test:integration --workspace server # endpoint, policy data, quotes (needs the database)
```

The fare tests are explicit about the parts that are easy to get quietly wrong: that the policy seed is idempotent and creates no duplicate version; that `(code, version)` is unique; that a quoted version cannot be re-priced, renamed rates aside; that the correct version is selected for an instant, and that a missing or overlapping configuration is a controlled failure; that money is exact decimal and that a JavaScript `number` is refused; that the base fare is included once; that the per-kilometre fare uses network edge distances and the per-minute fare the routed duration; that fare weight scales the distance fare and cannot change the route; that the multiplier is applied once; that the minimum fare is enforced and recorded; that rounding is deterministic and happens at the documented boundaries; that a stored quote references its policy version and carries an auditable snapshot whose charges add up; that it cannot be modified or reached by any update path; that expiry is exactly the TTL and never deletes; that invalid weights, missing policies and unreachable routes are controlled errors; and that a client cannot influence any of it.

### Demo pricing disclaimer

**Every rate in `server/src/db/seeds/fare.data.js` is invented demo configuration, not official transport pricing.** The values (`40.00` base, `18.00`/km, `2.00`/min, `80.00` minimum, `1.10` peak multiplier) exist to make the pricing pipeline demonstrable and testable. They are not Dhaka taxi, rickshaw, ride-share or regulatory rates, and nothing here should be quoted to anybody as a real price. The seeder also refuses to run in production unless `ALLOW_DEMO_SEED=true`, exactly like the demo accounts.

### What is deliberately not here

Fare quoting stops at a price. There is **no** ride request, ride event, passenger ownership, request idempotency, pool, pool member, shared fare, pooling discount, ride matching, seat reservation, driver assignment, payment, wallet or demand-based surge pricing -- and no external pricing or routing API. The fare is a **solo** fare: one journey, one passenger, one price.

A quote is not attached to a user in this phase. The next milestone adds the `RideRequest` that accepts one, which is when ownership and idempotency become meaningful, and which is why quotes are stored rather than recomputed.


## Tests

```bash
npm test                        # everything
npm run test:unit --workspace server
npm run test:integration --workspace server
```

Tests use Node's built-in runner (`node --test`) — no extra dependencies. The integration suites run against the real PostgreSQL database from `DATABASE_URL`, apply `server/db/*.sql` and the seed themselves, and clean up after themselves; the database must be reachable (`npm run db:up`). Constraint tests run inside rolled-back transactions.

Coverage highlights: the PostGIS extension and the real spatial column types; the GiST spatial indexes; that coordinates are stored longitude-first; `ST_DWithin` proximity answering in metres with a distant point correctly excluded; the seed totals, per-zone point counts, correct zone membership and idempotency; the coordinate bounds; and -- for the graph -- no isolated vertex, one weakly connected component, every zone linked to another, edge endpoints aligned with their vertices, edge distance matching `ST_Length`, and the direction / duration / fare-weight invariants. It also asserts that the superseded `/api/transport/*` endpoints are gone, and that `/api/location/*` still exposes no routing of its own. Routing and pricing are covered by their own suites -- see [Routing](#routing) and [Fare quotes](#fare-quotes) for the lists.

## Next steps

- Decide how schema changes are reviewed now that Prisma is in place: keep the idempotent `server/db/*.sql` files as the source of truth (the current setup, and what preserves the `CHECK` constraints and GiST indexes Prisma cannot model), or move fully to Prisma Migrate and express those another way.
- Build the next milestone on top of fare quoting: **ride requests**. That is where a quote gets accepted, where ownership and idempotency become meaningful, and where the stored `FareQuote` (rather than a recomputation) is what a request points at. Pooling, shared fares and payments come after that.
- Consider time-dependent profiles *within* a journey (the current router picks one profile from the departure instant and applies it to the whole route), which needs per-second costs and a time-dependent router.
- Authenticate the client: send the auth cookie from the Next.js app, then tighten `GET /api/users`, which is still public so the demo page keeps rendering. `POST /api/routes/estimate` already requires a session, so the client needs to carry the cookie before it can call it.
- Add email verification and password reset. Sign-up currently accepts any address a caller supplies, so nobody proves they own the email they register with.
- Rate-limit `POST /api/auth/login` and `POST /api/auth/register`. No limiter is installed yet, so password guessing and bulk sign-ups are unthrottled.
- JWT logout cannot revoke a token before it expires. Add a token denylist (or move to opaque server-side sessions) if immediate revocation becomes a requirement.
- Add validation (e.g. `zod`) for request bodies once write endpoints exist.
- Add Playwright coverage for the client.
