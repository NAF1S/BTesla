# `server/test/helpers/` — the fixtures every suite shares

Four modules, imported by the suites (never by `src/`).

| Helper | What it gives a suite |
| ------ | --------------------- |
| `test-env.js` | Loads the environment the way the server does. **Import this first, before anything that reads `env`.** |
| `db.js` | `pool` (raw SQL), `prepareDatabase()`, `withRollback()`, `expectPgError()`, `sqlStateOf()`, `closePool()` |
| `api-server.js` | `startApiServer()` → `{ baseUrl, request, close }`: the real Express app on an ephemeral port |
| `drivers.js` | `POINTS`, `loadDemoUser`, `servicePointId`, `createTestDriver`, `removeTestDriver`, `goOnline`, `goOfflineQuietly`, `resetDispatchState`, `withEnv` |

## Why it matters

* **The integration suites talk to the real thing.** `startApiServer` mounts the
  actual Express app (`src/app.js`), so a suite exercises routing, validation,
  serializers and the error handler — not a mock of them. That is why a test can
  prove a `400` message, or that an unknown query parameter is rejected.
* **`prepareDatabase()` applies the migrations and seeds** before a suite runs, so
  a suite never depends on a hand-prepared database.
* **`withRollback(fn)` runs inside a transaction that is always rolled back**, which
  is how constraint tests assert a SQLSTATE without leaving a row behind.
  `expectPgError` wraps each failing statement in a savepoint and rolls it back, so
  one test can assert several violations and the transaction stays usable.
* **`resetDispatchState()` is the shared-state reset** and belongs in
  `beforeEach`: dispatch, matching and the trip are global features, so a driver
  left `AVAILABLE` by one test is a candidate for the next one's ride request.
* **`withEnv(target, overrides, fn)`** temporarily changes a threshold, which is
  how a limit is proven to be enforced without a second process.

## What a frontend benefits from

These helpers are why a change to a response contract is caught. The suites drive
the same HTTP shapes a client does, and the fixtures are built the way the product
builds them — a quote, a request, a dispatch offer, an acceptance, a join, then the
trip commands over HTTP — so a passing suite means a client in that state would
work.

## Rules the helpers encode

1. **Fixtures are created the way the product creates them.** A row written by
   hand is a last resort for a state the product cannot reach, and it must be a
   *consistent* row (a stop that is `ARRIVED` has an arrival time; a request that
   is `COMPLETED` has `started_at` and `completed_at`).
2. **Quote at the instant you plan at.** A passenger's detour is measured against
   the duration their own quote froze, so a fixture that pins a quote to a fixed
   hour passes at noon and fails inside Dhaka's rush hours.
3. **A failing hook cancels the whole file.** Close the server and the pool in a
   `finally`, and make fixtures delete-before-create so one bad run does not poison
   the next.
4. **`pool.query(sql, params)` spreads the parameter array**, so an array parameter
   must be wrapped: `pool.query(sql, [arrayParameter])`.

## Depends on / depended on by

Depends on `../../src/` and on the database from `DATABASE_URL`. Depended on by
every suite in `../unit/` and `../integration/`. Nothing in `src/` may import from
`test/`.
