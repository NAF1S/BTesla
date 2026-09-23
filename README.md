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
│   │   ├── 03-transport-network.sql   # zones, stops, corridors, travel estimates
│   │   └── 04-auth.sql     # roles, profiles, vehicles
│   ├── prisma/
│   │   └── schema.prisma   # Prisma view of the SQL schema (introspected)
│   ├── prisma7.config.ts   # Prisma CLI config (reuses src/config/env.js)
│   ├── src/
│   │   ├── index.js        # HTTP server bootstrap + graceful shutdown
│   │   ├── app.js          # Express app: middleware, routes, error handling
│   │   ├── config/env.js   # Environment configuration
│   │   ├── db/             # Prisma client, health probe, migration runner, seeder
│   │   │   └── seeds/      # transport + demo account seed data, idempotent upserts
│   │   ├── routes/         # Route definitions (index, health, auth, users, transport)
│   │   ├── controllers/    # Request handlers
│   │   ├── services/       # Business logic / queries
│   │   ├── serializers/    # Record -> response DTO mappers
│   │   ├── middleware/     # notFound, errorHandler, auth (requireAuth, requireRole)
│   │   └── utils/          # ApiError, validation, password, token, cookies
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

| Script                  | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `npm run dev`         | Run the API and the web client concurrently       |
| `npm run dev:server`  | Express only, with`node --watch` on port 4000   |
| `npm run dev:client`  | Next.js dev server on port 3000                   |
| `npm run build`       | Production build of the Next.js client            |
| `npm start`           | Run both apps in production mode                  |
| `npm run lint`        | ESLint for the client                             |
| `npm run db:up`       | Start the PostgreSQL container                    |
| `npm run db:down`     | Stop the container (keeps data)                   |
| `npm run db:reset`    | Recreate the container**and wipe data**     |
| `npm run db:generate` | Regenerate the Prisma client from the schema      |
| `npm run db:migrate`  | Apply`server/db/*.sql` to the database          |
| `npm run db:seed`     | Apply the transport demo seed (idempotent)        |
| `npm run db:psql`     | Open a psql shell in the container                |
| `npm run db:logs`     | Follow the Postgres logs                          |
| `npm test`            | API unit + integration tests (needs the database) |

## Database

PostgreSQL 17 runs via `docker-compose.yml`:

| Setting         | Value                                                   |
| --------------- | ------------------------------------------------------- |
| Database        | `TeslaB`                                              |
| User / password | `postgres` / `postgres`                             |
| Host port       | **`55432`** (container port 5432)               |
| Connection URL  | `postgres://postgres:postgres@localhost:55432/TeslaB` |

> **Why port 55432?** This machine already has a local PostgreSQL service on `5432` and another container on `5433`. Override with `POSTGRES_PORT` in a root `.env` (see `.env.example`) and update `DATABASE_URL` in `server/.env` to match.

### ORM (Prisma)

All database access goes through **Prisma**. `server/src/db/prisma.js` exports the single client, built on the official `@prisma/adapter-pg` driver adapter (which Prisma 7 requires for PostgreSQL). Services use Prisma models rather than hand-written SQL, and error handling maps both Prisma error codes (`P2002` → 409, `P2025` → 404) and the SQLSTATEs Prisma nests inside raw-SQL errors, so the 400/404/409 contract is unchanged.

The relationship between Prisma and the SQL files is deliberate:

- **`server/db/*.sql` remains the source of truth for the physical schema.** `server/prisma/schema.prisma` was produced by introspecting it (`prisma db pull`) and maps onto the existing snake_case tables and columns with `@@map`/`@map`, so renaming a Prisma model does not rename a table.
- **`prisma migrate` is intentionally not used.** Prisma does not model `CHECK` constraints, so handing it ownership of migrations would try to drop constraints such as `travel_estimates_distinct_stops`. Migrations stay hand-written and are applied by `npm run db:migrate`, which executes each file through Prisma, one transaction per file.
- `DATABASE_URL` is resolved by `server/src/config/env.js` for both the API and the Prisma CLI (`prisma7.config.ts` imports that module), so the two cannot drift apart and the API still runs with no `.env` file at all.

To check that the Prisma view still matches the live database:

```bash
cd server
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

An empty migration means there is no drift. Like `pg_typeof()`, a few PostgreSQL internals cannot be read through Prisma raw queries; cast them (`pg_typeof(x)::text`) when you need them.

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

| Table                | Purpose                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `zones`            | Geographical grouping; unique`code`, `active` flag                         |
| `stops`            | Pickup/drop-off points, each in one zone; unique`code`, optional coordinates |
| `corridors`        | Named route corridors; unique`code`, `active` flag                         |
| `corridor_stops`   | Ordered corridor membership:`(corridor_id, stop_id)` PK + `position`       |
| `travel_estimates` | Directional hop estimates: minutes, kilometres, fare                           |

Design notes:

- Money (`base_fare`), distances (`estimated_distance_km`) and coordinates (`latitude`, `longitude`) use `NUMERIC`, never floating point.
- `corridor_stops` has a composite primary key `(corridor_id, stop_id)`, so a stop can appear at most once per corridor, plus `UNIQUE (corridor_id, position)`, so two stops cannot share a slot.
- The ordered stop list of a corridor lives in `corridor_stops`, never in a JSON column.
- `travel_estimates` is directional: `(from_stop_id, to_stop_id)` is unique and `from_stop_id <> to_stop_id` is enforced; `A → B` and `B → A` are separate rows and neither implies the other.
- `updated_at` is maintained by a shared `set_updated_at()` trigger; internal timestamps are never returned by the API.

## API

Base URL: `http://localhost:4000/api`

| Method   | Endpoint                        | Description                                                                                                             |
| -------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                     | Service status, uptime, and database probe                                                                              |
| `GET`  | `/users` must be locked       | List users (lock kora lagbe)                                                                                            |
| `GET`  | `/users/:id`                  | Get a single user (`404` if missing)                                                                                  |
| `POST` | `/users`                      | Create a user (**ADMIN only**) — body: `{ "name", "email" }`                                                   |
| `POST` | `/auth/register`              | Sign up as PASSENGER or DRIVER; signs in — body:`{ "name", "email", "password", "role"? }`                           |
| `POST` | `/auth/login`                 | Log in; sets the HttpOnly auth cookie — body:`{ "email", "password" }`                                               |
| `GET`  | `/auth/me`                    | Current user (requires authentication)                                                                                  |
| `POST` | `/auth/logout`                | Clear the auth cookie (safe to retry)                                                                                   |
| `GET`  | `/transport/zones`            | List active zones                                                                                                       |
| `GET`  | `/transport/stops`            | List active stops, optional`?zoneCode=`                                                                               |
| `GET`  | `/transport/stops/:code`      | Get one stop by code                                                                                                    |
| `GET`  | `/transport/corridors`        | List active corridors                                                                                                   |
| `GET`  | `/transport/corridors/:code`  | Corridor with its stops ordered by`position`                                                                          |
| `GET`  | `/transport/corridors/match`  | Corridors serving a pickup/drop-off pair, e.g.`?pickupStopCode=banani-road-11&dropoffStopCode=mohakhali-bus-terminal` |
| `GET`  | `/transport/travel-estimates` | Direct estimate, e.g.`?fromStopCode=banani-road-11&toStopCode=gulshan-1`                                              |

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

| Status  | Meaning                                                              |
| ------- | -------------------------------------------------------------------- |
| `400` | Missing, malformed, repeated or unsupported query parameter          |
| `404` | Unknown code, or no record for the requested directional pair        |
| `409` | The record exists but is inactive (also used for database conflicts) |

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

`POST /api/users` is gated with `requireRole(Role.ADMIN)`. That is both a real use of the guard and what stops a client from choosing `ADMIN` when creating an account. The read endpoints (`GET /api/users`) are still public so the Next.js demo page keeps working; tightening them is a follow-up once the client can send the cookie.

Authorization is always decided on the server from the database record. Hiding routes in the front end is not authorization.

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

| From                    | To                      |
| ----------------------- | ----------------------- |
| Banani Road 11          | Gulshan 1               |
| Banani Road 11          | Mohakhali Bus Terminal  |
| Banani Kakoli           | Gulshan 1               |
| Banani Kakoli           | Mohakhali Wireless Gate |
| Gulshan 1               | Mohakhali Wireless Gate |
| Mohakhali Wireless Gate | Mohakhali Bus Terminal  |

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

- Decide how schema changes are reviewed now that Prisma is in place: either keep the idempotent `server/db/*.sql` files as the source of truth (the current setup, and what preserves the `CHECK` constraints Prisma cannot model), or move fully to Prisma Migrate and express those constraints another way.
- Authenticate the client: send the auth cookie from the Next.js app, then tighten `GET /api/users`, which is still public so the demo page keeps rendering.
- Add email verification and password reset. Sign-up currently accepts any address a caller supplies, so nobody proves they own the email they register with.
- Rate-limit `POST /api/auth/login` and `POST /api/auth/register`. No limiter is installed yet, so password guessing and bulk sign-ups are unthrottled.
- JWT logout cannot revoke a token before it expires. Add a token denylist (or move to opaque server-side sessions) if immediate revocation becomes a requirement.
- Add validation (e.g. `zod`) for request bodies once write endpoints exist.
- Add Playwright coverage for the client.
