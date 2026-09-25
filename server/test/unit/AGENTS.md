# `server/test/unit/` — no database, no clock, no HTTP

One file per module under test, asserting the *rules* rather than the wiring.

| File | Covers |
| ---- | ------ |
| `trip.rules.test.js` | The six trip decisions and the order they are asked in, the stop order, the passenger stage and next action, `allowedActions` |
| `timeline.rules.test.js` | The event mapper: which event each audience may see, and what never reaches a response |
| `pool-fare.rules.test.js` | Onboard-per-leg, leg cost, the split and its residual, the two caps, the totals identity |
| `matching.rules.test.js` | Insertion positions, occupancy, plan metrics, the limits, scoring, the tie-break |
| `dispatch.rules.test.js` | Availability, offer states, pool/stop/member vocabulary, candidate scoring |
| `ride.status.test.js` | Request statuses, the transition table, cancellation reasons |
| `passenger-ride.serializer.test.js`, `driver-ride.serializer.test.js`, `pool.serializer.test.js`, `driver.serializer.test.js`, `ride-request.serializer.test.js`, `location.serializer.test.js`, `user.serializer.test.js` | The DTO whitelists |
| `openapi.test.js` | The spec against the routes |
| `validation.test.js`, `password.test.js`, `geo.test.js`, `errorHandler.test.js`, `location.data.test.js`, `auth.middleware.test.js` | The utilities and the seeded data |

## Why it matters

This directory is the **specification of the rules, written down where they can be
read in one sitting**. Two properties are why it earns its keep:

* **No database and no clock**, so a rule can be checked quickly and precisely.
  Arrival arithmetic, a fare split and a tie-break are asserted against numbers a
  human can verify by hand, with distances given as literal metres rather than
  measured by the router.
* **The boundary is asserted, not the happy path.** Every serializer test has a
  fixture that *carries* the field it must not publish — an email, a fingerprint, a
  co-passenger's id — so a serializer that started reading one fails the test
  instead of leaking. `timeline.rules.test.js` asserts that an event type added by
  a future milestone is invisible by default.

## What a frontend gets from here

The DTO shapes and the derived fields are pinned here, so a client can rely on:

* the exact key set of every response it reads (`Object.keys(...).sort()` is
  asserted, so a new key is a deliberate change with a test update);
* money as exact decimal strings;
* `stage` / `nextAction` / `allowedActions` computed from the state, with the
  mapping from every stage to its action asserted exhaustively;
* `openapi.yaml` describing every mounted path, checked against the route files.

## Depends on / depended on by

Depends on `../helpers/test-env.js` and on `../../src/`, and nothing else — no
database connection is opened except by the suites that genuinely need one.
Depended on by nobody. `npm run test:unit --workspace server` runs this directory
alone, which is the fast loop while editing a rules module.
