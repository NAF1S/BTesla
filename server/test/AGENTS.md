# `server/test/` — the suites

Node's built-in runner (`node --test`), no test framework, no mocking library.
`npm test` runs `test/**/*.test.js` with `--test-concurrency=1`; the integration
suites talk to the real database and the real API.

```
helpers/      fixtures the suites share
unit/         pure rules and serializers: no database, no clock, no HTTP
integration/  the database, the services and the HTTP surface
```

## `helpers/`

| Helper | What it gives a suite |
| ------ | --------------------- |
| `test-env.js` | Loads the environment the way the server does (import this first) |
| `db.js` | `pool` (raw SQL), `prepareDatabase`, `withRollback`, `expectPgError`, `sqlStateOf`, `closePool` |
| `drivers.js` | `POINTS`, `loadDemoUser`, `createTestDriver`, `removeTestDriver`, `goOnline`, `resetDispatchState`, `withEnv` |
| `api-server.js` | `startApiServer()` → `{ baseUrl, request, close }`, an in-process API on a real socket |

## Rules the suites follow

1. **Fixtures are created the way the product creates them** — a quote, a request,
   a dispatch offer, an acceptance, a join. A row written by hand is a last resort
   for a state the product cannot reach, and it must be a *consistent* row (a stop
   that is `ARRIVED` has an arrival time; a pool that departed has `departed_at`;
   a request that is `COMPLETED` has `started_at` and `completed_at`). Helpers that
   fill those instants in from the status (`insertPool`, `insertRequest`) take an
   opt-out — `{ fillImpliedTimestamps: false }` — which is what the tests that
   *want* the disagreement use to reach the `CHECK`.
2. **Quote at the instant you plan at.** A passenger's detour is measured against
   the duration their own quote froze, so a quote priced in one traffic regime and
   a plan measured in another makes every join look like a detour. Fixtures
   therefore price at `new Date()`, not at a pinned noon. (Pinning noon made the
   matching suites pass in Dhaka's off-peak window and fail inside the rush hours,
   07:30–10:30 and 16:30–20:00.)
3. **Reset in `beforeEach`.** Dispatch and matching are shared-state features:
   `resetDispatchState()` clears rides, offers, pools, driver availability and
   vehicles. A leaked active request or pool makes the *next* suite fail.
4. **Assert invariants under a race, not a winner.** Where two commands are issued
   with `Promise.all`, assert what must be true either way (one event, a consistent
   state) — which of the two wins is the database's decision.
5. **A failing hook cancels the whole file.** Close the server and the pool in a
   `finally`, and make fixtures delete-before-create so a run that died earlier
   does not poison the next one.
6. **Constraints are tested against the database**, inside `withRollback`, by
   expecting a SQLSTATE (`expectPgError(tx, work, '23514')`).

## Depends on / depended on by

Depends on `src/` (the services and their rules) and on the database from
`DATABASE_URL`. Nothing in `src/` may import from `test/`.

## What future agents must preserve

* Every milestone's suite stays green — they are the specification for the
  features that came before. When a rule legitimately changes, the *boundary*
  assertions in the older suites must be updated to the new truth rather than
  deleted.
* The suites stay honest about scope: no payment, wallet, payout, settlement,
  rating, notification, live-tracking or passenger-side cancellation endpoint
  exists, and the suites assert that.
