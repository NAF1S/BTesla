# `server/src/` — the API's layers

```
routes/       URL shapes, role guards, nothing else
controllers/  read the request, call one service, choose a DTO and a status code
services/     the domain: rules, transactions, locks, events
serializers/  one whitelist DTO per resource
middleware/   authentication, error handling, 404
config/env.js every tunable in one place
utils/        ApiError, validation, time, cookies, tokens, geo
commands/     operator entry points (the sweeps and the fare repair)
db/           the Prisma client and the migration runner
```

## The rules modules (pure, unit tested, no I/O)

| Module | What it owns |
| ------ | ------------ |
| `ride.status.js` | Ride-request statuses, the transition table, cancellation reasons, fingerprints |
| `dispatch.rules.js` | Driver availability, offer states, pool/stop/member vocabulary, candidate scoring |
| `matching.rules.js` | Insertion positions, occupancy, plan metrics, the limits, plan ordering |
| `pool-fare.rules.js` | Onboard-per-leg, leg cost, the split and its residual, the two caps, totals |
| `trip.rules.js` | The stop order, the six trip decisions, `allowedActions`, the passenger's stage |

Each one is imported by its service, mirrored by constraints in `db/*.sql`, and
covered by a `test/unit/*.rules.test.js`. **Change the rules there, never inline in
a service**: the database and the tests both read from these tables.

## The services that write

| Service | Responsibility |
| ------- | -------------- |
| `auth.service.js`, `user.service.js` | Accounts, sessions, the demo cast |
| `location.service.js`, `routing.service.js` | Service points, `pgr_dijkstra` journeys |
| `fare.service.js` + `fare.calculator.js` | Solo quotes: policy, traffic, rounding |
| `ride-request.service.js` | The request lifecycle and **the only writer of `ride_requests.status`** |
| `driver.service.js` | Availability, vehicles, freshness |
| `dispatch.service.js`, `offer.service.js` | Offers, acceptance, rejection, the pool a match creates |
| `matching.service.js`, `assignment.service.js` | Candidate pools, plan simulation, offer or fall back |
| `pool.service.js` | Pool creation, plan rewrites, pool events |
| `pool-fare.service.js` | The versioned shared-fare ledger, and freezing it at departure |
| `trip.service.js` | Depart, arrive, collect, start, deliver, complete |
| `driver.service.js` / `pool.service.js` loaders | Post-commit relation reads for the DTOs |

## Rules worth knowing before editing

* `requireAuth` loads the user; `requireRole(…)` checks the database role; the
  actor is then taken from that record. **No endpoint accepts an actor id.**
* Another driver's pool or offer is a **404**. A passenger's request is theirs
  only; a 403 is used only for "authenticated, wrong role".
* All money is `Prisma.Decimal`; `formatMoney(value, scale)` produces the string a
  DTO carries.
* Relations are read **after** the commit. Never use a nested Prisma `include`
  inside an interactive transaction — it issues concurrent queries on the single
  connection.
* `appendRideEvent` and `appendPoolEvent` need the owning row's lock: the sequence
  number is per request/pool and must be race-free.
* Trip commands take no body at all, and answer with the pool's current state.
  The decisions come from `trip.rules.js`; the service locks, asks, and writes.

## Depends on / depended on by

Depends on `db/` (Prisma), `config/env.js`, and `utils/`. Depended on by
`routes/` + `controllers/` (the HTTP surface) and by `commands/` (the sweeps).
Nothing in `src/` may import from `test/`.

## What future agents must preserve

* One writer per piece of state: `ride-request.service.js` for a request's status,
  `trip.service.js` for a pool's, its stops' and its members' statuses.
* The lock order documented at the top of `offer.service.js`,
  `pool-fare.service.js` and `trip.service.js`.
* Every operation is idempotent before it is clever: a retry answers with the
  current state, moves no timestamp and writes no second event.
* Adding a field to a DTO is a product decision about privacy. Check what the
  passenger or driver is *not* supposed to see first.
