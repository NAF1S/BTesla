# TeslaB — repository guide for coding agents

A ride-pooling demo: a Next.js client and an Express API over PostgreSQL + PostGIS +
pgRouting + Prisma. This file is the map; **every folder has its own `AGENTS.md`** —
read the one nearest the code you are about to change.

## Layout

| Path | What lives there |
| ---- | ---------------- |
| `client/` | Next.js 16 (App Router, JavaScript, Tailwind v4). The **passenger** app: auth, locations, fare estimate, ride request, live tracking. Nothing else. |
| `server/` | The Express 5 API. **All the domain rules live here.** See `server/AGENTS.md`. |
| `server/db/*.sql` | Hand-written, idempotent migrations. The schema's source of truth. |
| `server/openapi.yaml` | The machine-readable API contract, served at `GET /api/docs`. |
| `docker/db/Dockerfile` | The database image: PostGIS 17 + pgRouting. |
| `docker-compose.yml` | Runs that image on host port **55432**. |

## The two things a frontend is built on

```text
Passenger:  GET /api/passengers/me/current-ride     -> { ride } or { ride: null }
            GET /api/passengers/me/rides            -> { data, pagination }
            GET /api/passengers/me/rides/:id        -> stops, timeline, fare

Driver:     GET /api/drivers/me/current-pool        -> allowedActions is the buttons
            PATCH /api/drivers/me/availability      -> { online, servicePointCode }
            GET /api/drivers/me/rides[/:poolId]     -> the pools they have driven
```

**Never compute a state transition in a client.** The server publishes
`allowedActions` (driver) and `nextAction` (passenger), computed from the state, so
a client renders what the server would accept instead of reimplementing the rules.
Nothing takes a user id: every `/me` path already knows who is asking.

## Running it

```bash
npm run db:up                # start the database (docker compose)
npm run db:migrate           # apply server/db/*.sql, idempotent, safe to re-run
npm run db:seed              # demo accounts, locations, pricing
npm test                     # the whole server suite (needs the database)
npm run dev                  # API + client together
```

`npm test` takes a few minutes: the integration suites route real journeys through
pgRouting. Always run it before claiming a change is done. **`--test-concurrency=1`
is required** — the files share one database, and two at once corrupt each other's
state in ways that look exactly like real bugs.

## Conventions that apply across the repository

1. **The database enforces the product.** Every guarantee has a `CHECK`, a trigger,
   a foreign key or a partial unique index behind it, not just a service check. If
   you add a rule, ask which constraint would refuse the state it forbids.
2. **Migrations are idempotent and cumulative.** `server/db/NN-*.sql` re-runs on
   every `db:migrate`; use `IF NOT EXISTS` / `DROP … IF EXISTS`, and prefer
   appending a convergence section over editing what was already applied.
3. **Money is exact decimal.** `Prisma.Decimal` (decimal.js-*light*: no `shiftedBy`)
   and `numeric` columns; a JavaScript `number` is refused for money.
4. **State machines live in code, as data.** `ride.status.js`, `dispatch.rules.js`,
   `matching.rules.js`, `pool-fare.rules.js`, `trip.rules.js` are pure and unit
   tested, and they are the single definition the services, the SQL and the tests
   share. Never re-implement a transition inline.
5. **Timelines are append-only.** `ride_events` and `pool_events` refuse UPDATE by
   trigger; an event is written in the same transaction as the state change it
   records, and a retry must not write a second one.
6. **Ids come from the session, never from a body.** Authorization is
   `requireAuth` + `requireRole`, and a resource that is not the caller's is a
   **404**, not a 403 — a 403 confirms the id exists.
7. **Serializers are whitelists.** A DTO is built field by field from one row (or
   one member's rows); if a value is not in the DTO, no client can ask for it.
8. **Documentation is part of the change.** A new endpoint, rule or table belongs
   in `README.md` (the milestone's section), in `server/openapi.yaml` (the
   machine-readable contract — a route that is not documented fails
   `test/unit/openapi.test.js`) and in the nearest `AGENTS.md`.
9. **A read is a projection, not a loop.** A page costs the same however many rows
   it returns. Prisma emits `query` events under `NODE_ENV=test`, which is how the
   read suites prove it by *counting queries* rather than checking the JSON.

## What must not be broken

* The existing suites: authentication, routing, fares, ride requests, dispatch,
  matching, shared fares, the trip and the read APIs. They are the specification.
* The reserved states (`CANCELLED`, `NO_SHOW`, `SKIPPED`, a cancelled pool) stay
  defined and unused until a milestone needs them.
* No payment, wallet, refund, payout, rating, notification, live GPS or
  passenger-side cancellation exists yet. Do not invent one as a side effect.

## Where to look for what

| Question | File |
| -------- | ---- |
| What does this endpoint answer, exactly? | `server/openapi.yaml`, or `README.md` |
| Why is it shaped that way? | `README.md`, one section per milestone |
| How do I work in this folder? | that folder's `AGENTS.md` |
| What are the rules as data? | `server/src/services/*.rules.js` and their unit tests |
| What is the schema, and why? | `server/db/*.sql`, and `server/prisma/AGENTS.md` for the Prisma mirror |
