# `server/src/commands/` — the operations a scheduler will run

Standalone entry points, each an `npm run` script. They are **not** HTTP
endpoints: nothing calls them, and they exist for the work that has to happen on a
clock rather than in a request.

| Script | What it does |
| ------ | ------------ |
| `npm run ride-requests:expire --workspace server` | Expires `WAITING` requests past their `search_expires_at`, one small transaction each |
| `npm run dispatch:sweep --workspace server` | Expires overdue offers, then re-assigns the requests they were holding |
| `npm run pool-fares:recalculate --workspace server` | Prices any forming pool whose shared-fare calculation is missing or stale |

## Why it matters

These are the only writers that run **outside** a user's request, so they carry
three obligations a request handler does not:

* **Each one is idempotent and safe to re-run.** A sweep that ran twice must not
  expire an offer twice or write a second event.
* **Each one is bounded.** `maxPoolsPerSweep` and an explicit `limit` keep a run
  from holding the database for the length of the backlog, and they report what
  they examined, changed and skipped rather than dying on the first odd row.
* **Each one is honest about what it could not do.** The fare repair *skips*
  a pool whose plan moved underneath it instead of guessing at which version to
  price.

## What a frontend does not depend on

Nothing here is reachable over HTTP, and there is no endpoint that triggers one.
A client should never see a request disappear because a sweep ran: expiration is
the product's own rule (`searchTtlSeconds`), and a client learns about it by
reading the request, which is `EXPIRED`.

## Depends on / depended on by

Depends on `../services/` and `../db/prisma.js`. Depended on by
`package.json`'s scripts and by nothing else in `src/`. Each closes the pool in a
`finally` so a failure leaves no open handles.

## Rules worth preserving

* A new sweep gets an `npm run` script, a bound, a summary line and a test.
* A sweep never changes a rule — it applies one that already exists in a
  `*.rules.js` module.
