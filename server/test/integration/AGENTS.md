# `server/test/integration/` — the real database, over real HTTP

One file per milestone, each driving the actual Express app against the actual
PostgreSQL database. They are the **behavioural specification**: where a unit test
proves a rule, these prove the contract a client actually gets.

| File | Covers |
| ---- | ------ |
| `passenger-read-api.integration.test.js` | Current ride, history, detail: ownership, filters, pagination stability, timeline privacy, query counts |
| `driver-ride-history.integration.test.js` | The driver's current pool and ride history: ownership, ordering, fare totals, availability and dispatch |
| `docs.api.integration.test.js` | `GET /docs`: the document is really served, byte for byte, without a session |
| `driver-availability.api.integration.test.js` | Availability: the unified `PATCH`, the dedicated endpoints, every refusal |
| `trip.integration.test.js` | The trip lifecycle end to end, including the races |
| `dispatch.integration.test.js` | Offers, acceptance, rejection, expiry, the sweeps |
| `matching.integration.test.js` | Candidate pools, the offer lifecycle, plan rewrites, the last-seat race |
| `pool.integration.test.js` | Pool creation and the pool constraints |
| `pool-fare.integration.test.js` | The shared-fare ledger, the caps, the races |
| `ride-request.api.integration.test.js`, `ride-request.lifecycle.integration.test.js` | The request lifecycle and its constraints |
| `fare.api.integration.test.js`, `routing.api.integration.test.js`, `auth.api.integration.test.js`, `location.api.integration.test.js` | Quotes, routing, accounts, places |
| `*schema.integration.test.js`, `*.seed.integration.test.js`, `routing-graph.integration.test.js` | The constraints, the seeded data and the routing graph |

## Why it matters

* **A suite runs the migrations and seeds itself** (`prepareDatabase()`), so it
  never depends on a hand-prepared database and cannot be fooled by stale rows.
* **Ownership is tested with two of everything.** Every privacy test has a *second*
  passenger and a *second* driver who have really ridden, because a filter that
  returned everything would pass a test with only one user in the database. The
  co-owner is the fixture, not an afterthought.
* **Races assert invariants, not winners.** Where two commands are issued with
  `Promise.all`, the test asserts what must be true either way (one event, a
  consistent state) rather than which of them won — that is the database's
  decision, and demanding one would be flaky rather than precise.
* **Query counts are measured, not assumed.** Prisma emits `query` events under
  `NODE_ENV=test` (see `src/db/prisma.js`), and the read suites count them to prove
  a page costs the same for one row as for ten. A per-row query would produce
  identical JSON and a growing count.

## Running them

```bash
npm run db:up                                   # the database must be reachable
npm test                                        # everything (~4 minutes)
npm run test:integration --workspace server      # just these
node --test --test-concurrency=1 test/integration/<one>.test.js
```

`--test-concurrency=1` is **required**: the files share one database, and running
two at once makes them corrupt each other's state in ways that look like real bugs.

## Depends on / depended on by

Depends on `../helpers/` and on `../../src/`. Depended on by nobody, except that
the whole suite is the gate in `AGENTS.md` at the repository root: *run it before
claiming a change is done*.

## Rules worth preserving

* **When a rule legitimately changes, update the older suite's boundary assertions
  to the new truth rather than deleting them.** They are the specification for the
  features that came before.
* **Keep the scope assertions.** Several suites assert that no payment, wallet,
  payout, settlement, rating, notification, live-tracking or passenger-side
  cancellation endpoint exists. That is how the deferred list stays deferred.
* **A fixture that fabricates a status must write the instants that status
  implies**, or the lifecycle `CHECK`s refuse it — which is a feature, not an
  obstacle.
