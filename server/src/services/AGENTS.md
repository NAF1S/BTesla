# `server/src/services/` — the domain

Where the product actually lives: rules, transactions, locks, events, and the
read projections. `server/src/AGENTS.md` (the parent) has the full contract and a
table of every service; this file is the short version you need before editing one.

## Why it matters

Two conventions here are what keep the project from rotting, and both are easy to
break by accident.

### 1. Rules live in `*.rules.js`, as data — never inline

`ride.status.js`, `dispatch.rules.js`, `matching.rules.js`, `pool-fare.rules.js`,
`trip.rules.js` and `timeline.rules.js` are **pure**: no database, no clock, no
I/O. They export frozen tables and small functions.

The services, the SQL constraints, the serializers and the tests all read from
those tables, so a transition has **one definition**. If you find yourself writing
`if (status === 'MATCHED' && …)` inside a service, stop: that rule belongs in a
rules module, and the database very likely enforces a version of it too.

### 2. A write is one transaction, and the lock order is documented

Every service that changes state has a header comment naming its lock order, and
that order is load-bearing — two commands that take the same rows in different
orders deadlock under concurrency. The three that matter:

| Service | Order |
| ------- | ----- |
| `offer.service.js` | ride request, then offers, in every path |
| `pool-fare.service.js` | the pool, then its member requests |
| `trip.service.js` | pool → stops → member requests → driver, **except** departure, which locks the passengers whose join offers it cancels *first* (ascending id) |

### 3. Relations are read after the commit

Never use a nested Prisma `include` inside an interactive transaction: Prisma
resolves relations with several statements at once, the PostgreSQL adapter wants
one statement at a time on a connection, and pg@9 will refuse it. Read scalars
inside the transaction, then load relations after it commits. Every service that
needs a DTO follows this pattern; `loadXForDto` is where it lives.

Also: **do not `Promise.all` two queries.** Even outside a transaction, this
project issues them sequentially.

## The read services added by the read-API milestone

| Service | What it owns |
| ------- | ------------ |
| `passenger-ride.service.js` | The passenger's current ride, paged history, one ride in detail. Read-only; the lifecycle stays in `ride-request.service.js`. |
| `driver-history.service.js` | The driver's pools, paged and in detail. Read-only. |

Both put `passengerProfileId` / `driverProfileId` on **every** `where` clause, and
both take that id from the authenticated user. There is no function in either that
accepts a passenger or driver id from a caller, so "somebody else's ride" is a row
the query cannot see — which is why it is a 404 and not a 403.

Their other shared obligation is **avoiding N+1**: a page is read in a fixed
number of queries whatever its size (a joined page query, plus one fare query for
the whole page), and `test/integration/passenger-read-api.integration.test.js`
asserts that by *counting queries*, not by checking the JSON.

## What a frontend depends on from here

Indirectly, everything. Directly, these are the guarantees a client is built on:

* a serializer's derived fields (`stage`, `nextAction`, `allowedActions`) are
  computed by a rules module, not by the service, so they cannot drift;
* a delete or cancel never leaves a half-written journey: states are written with
  their instants and their event in one transaction;
* a repeated command returns the state it produced the first time.

## Depends on / depended on by

Depends on `../db/prisma.js`, `../config/env.js`, `../middleware/auth.js` (for the
actor's profile id) and `../utils/`. Depended on by `../controllers/` and by
`../commands/`. Also depended on directly by the integration suites, which drive
fixtures through these services rather than writing rows by hand.

## Rules worth preserving

* **One writer per piece of state.** `ride-request.service.js` owns
  `ride_requests.status`; `trip.service.js` owns a pool's, its stops' and its
  members'. Two writers is how a status machine gets a second, subtly different
  definition.
* **An event is written in the same transaction as the change it records**, and a
  retry must not write a second one.
* **Timelines are append-only** — `ride_events` and `pool_events` refuse `UPDATE`
  by trigger.
* **A new read gets an index or a comment saying why it does not need one.**
