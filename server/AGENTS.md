# `server/` — the TeslaB API

An Express 5 (ESM) REST API over PostgreSQL 17 + PostGIS + pgRouting, accessed
through Prisma 7 with the `@prisma/adapter-pg` driver adapter.

## Why it exists, and what it owns

Everything the product decides: authentication, location and routing, solo fare
quotes, ride requests, driver dispatch, pool-first shared matching, versioned
shared fares, and the driver-operated trip. The client is a view over this API and
holds no rules of its own.

## Layout

```
src/app.js            Express app: middleware, /api router, error handling
src/index.js          bootstrap (asserts production secrets, listens)
src/config/env.js     every tunable, read once from process.env
src/routes/           URL shapes and role guards
src/controllers/      HTTP: validation of the request, status codes, DTO choice
src/services/         the domain: transactions, locks, state machines, events
src/serializers/      whitelist DTOs (one per resource)
src/commands/         operator/scheduler entry points (sweeps, repairs)
src/db/               Prisma client, migration runner, seeds
db/*.sql              the schema's source of truth (see db/AGENTS.md)
test/                 unit + integration suites (see test/AGENTS.md)
```

Requests flow **routes → controllers → services → serializers**. A service never
sees `req`; a serializer never touches the database; a controller never opens a
transaction.

## Depends on

* PostgreSQL 17 with PostGIS and pgRouting (container `teslab-db`, host port
  **55432**), reached through `DATABASE_URL` (built from `POSTGRES_*` if unset).
* `Prisma.Decimal` for money. **`$queryRawUnsafe` returns the rows array, not
  `{ rows }`** — only the test helper wraps it.

## Depended on by

* `client/` — through the documented endpoints in `README.md`.
* The scheduler: `npm run ride-requests:expire`, `npm run dispatch:sweep`,
  `npm run pool-fares:recalculate`.

## State and authorization rules to preserve

* `ride_requests`: `WAITING → MATCHED → IN_PROGRESS → COMPLETED`, plus
  `WAITING → CANCELLED | EXPIRED`. `MATCHED → CANCELLED` is allowed by the
  database and performed by nothing.
* `ride_pools`: `FORMING → DRIVER_EN_ROUTE → ARRIVED → IN_PROGRESS → COMPLETED`.
  Only `FORMING` is matchable; a departed pool is closed to matching.
* `pool_stops`: `PENDING → ARRIVED → COMPLETED` **in sequence order**.
* `pool_members`: `ASSIGNED → PICKED_UP → DROPPED_OFF`.
* `driver_profiles.status`: `OFFLINE → AVAILABLE → RESERVED → ON_RIDE → AVAILABLE`.
  A reserved or on-ride driver cannot go offline themselves.
* Row locks are load-bearing. The order is **ride request, then its offers** for
  dispatch, and **pool, then stops, then member requests, then the driver** for
  fares and the trip — with one documented exception in departure (see the header
  of `src/services/trip.service.js`).
* Passenger endpoints are `requireRole(PASSENGER)` and address only the caller's
  own data; driver endpoints are `requireRole(DRIVER)` and act only on the
  caller's own profile and pools. Another driver's pool is a 404.

## Endpoints the frontend should use

Documented in full in `README.md` (API tables, one per milestone). The ones a
client needs today:

* `POST /api/auth/{register,login,logout}`, `GET /api/users/me`, `GET /api/users`
* `POST /api/routes/estimate`
* `POST /api/fare-quotes`
* `POST|GET /api/ride-requests`, `/my`, `/:id`, `/:id/cancel`, `/:id/fare`
* `GET|PUT /api/drivers/me/availability`, `/online`, `/offline`,
  `/current-service-point`, `/offers`, `/offers/:id`, `/current-pool`
  (`/pool` is the same handler, kept as an alias for callers written before the
  trip milestone)
* `POST /api/drivers/me/offers/:id/{accept,reject}`
* The trip: `POST /api/drivers/me/pools/:poolId/{depart,start,complete}` and
  `POST /api/drivers/me/pools/:poolId/stops/:stopId/arrive` /
  `.../stops/:stopId/members/:memberId/{pickup,dropoff}`

## What future agents must preserve

* The transaction boundary around every plan change: a pool that cannot be priced
  must not exist, and a fare must not move without a plan change.
* Idempotency by state for the trip commands (an exact retry is a 200 that changes
  nothing) and by idempotency key for `POST /ride-requests`.
* `allowedActions` is computed on the server by `trip.rules.js`. Do not let a
  client decide which transition is legal.
* The driver's pool DTO carries no money, and a passenger's DTO carries no other
  passenger. Both are whitelists: adding a field is a product decision.
