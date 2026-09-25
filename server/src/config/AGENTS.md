# `server/src/config/` — every tunable in one place

One module, `env.js`, exporting a single frozen-ish object of configuration. It
reads `process.env` once at import time, applies the docker-compose defaults so the
API runs with no `.env` file, and throws at startup on a value that cannot be
parsed (a bad rush-hour window, for instance).

## Why it matters

* **Configuration is read here and nowhere else.** No other module touches
  `process.env`. That is what makes `server/.env.example` the complete list of what
  a deployment can change, and what lets a test override a threshold through
  `withEnv(env.dispatch, {...})` and see the behaviour change.
* **The connection string has one source.** The Prisma CLI resolves
  `DATABASE_URL` through this module too (`prisma7.config.ts`), so the API and the
  migrations cannot drift apart.
* **Production must supply a real secret.** `JWT_SECRET` has a development-only
  fallback and `assertProductionSecrets()` refuses to boot in production without
  one.

## What a frontend is affected by

The defaults a client should assume when nothing is configured:

| Setting | Default | Effect a client can observe |
| ------- | ------- | --------------------------- |
| `port` | `4000` | The API's base URL (`http://localhost:4000/api`). |
| `clientOrigin` | `http://localhost:3000` | CORS `origin`, with credentials. |
| `authCookieName` | `teslab_auth` | The cookie name — and therefore the `securityScheme` in `openapi.yaml`. |
| `authTokenTtlSeconds` | 2 hours | How long a session lasts before a 401. |
| `rideRequests.historyPageSize` / `historyMaxPageSize` | `20` / `100` | The default and maximum `limit` on a history page. |
| `rideRequests.searchTtlSeconds` | 600 | How long a `WAITING` request keeps looking before `EXPIRED`. |
| `dispatch.offerTtlSeconds` | 30 | How long a driver has to answer an offer. Short on purpose: an offer holds both a passenger and the driver's single slot. |
| `dispatch.listPageSize` | 20 | The default `limit` on a driver's offer list and ride history. |

Everything else here is an operational threshold — dispatch radii, matching
limits, scoring weights, transaction ceilings — and changing one changes what the
product *does* rather than what a client sees.

## Depends on / depended on by

Depends on `dotenv/config` and `../utils/time.js`. Depended on by nearly
everything, and by `../db/prisma.js` for the connection string.

## Rules worth preserving

* A **rule version** is not configuration. `SHARED_FARE_RULE_VERSION` lives in
  `../services/pool-fare.rules.js` as a constant, so changing it is a code change
  that has to be published rather than a deployment setting that could silently
  re-price a stored fare.
* A **pricing code** is configuration, and a client can never choose one — a
  request cannot select a policy, and therefore cannot select a price.
* Adding a setting means adding it to `server/.env.example` in the same change.
