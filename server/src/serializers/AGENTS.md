# `server/src/serializers/` — the DTOs, and where privacy is enforced

One module per resource, exporting plain functions that turn database rows into
response objects. There is no class, no decorator and no schema validation here:
a serializer is a hand-written whitelist, and the whitelist **is** the privacy
policy.

## Why it matters

This is the boundary a frontend sees, and the last place a leak can be stopped.

* **A serializer is given what it is allowed to show.** Every one takes a row (or
  one passenger's rows) and builds a new object field by field. Nothing spreads a
  row, so a column added by a later migration does not appear in a response by
  accident — it appears only when somebody types it here.
* **Privacy is structural rather than a filter.** `passenger-ride.serializer.js`
  is handed *one* request and *one* member; there is no shape of its input from
  which another passenger could be built. A filter can be forgotten; an absent
  argument cannot.
* **Money is a string.** `formatMoney(value, scale)` produces the exact decimal a
  client displays. A JavaScript `number` is never used for money anywhere in this
  project.
* **Presentation fields are computed, not stored.** `stage`, `nextAction`,
  `cancellable`, `canGoOnline`, `canGoOffline` and `allowedActions` are derived
  from the state on every read, so a client cannot disagree with the server about
  which button to show.

## What is here

| File | Resource | Notes |
| ---- | -------- | ----- |
| `passenger-ride.serializer.js` | The passenger's ride, history, detail | `stage` + `nextAction`; only the caller's own member and stops |
| `ride-request.serializer.js` | A ride request, and its optional `trip` block | The trip is passed in only for a single request, never for a page |
| `driver.serializer.js` | Driver availability | `online` / `operationalStatus` / `servicePoint` |
| `driver-ride.serializer.js` | The driver's pool history and detail | Fare as a **pool total**; no per-passenger amount |
| `pool.serializer.js` | The pool a driver is driving | `allowedActions`, `nextStop`, `pricing` (a boolean, never an amount) |
| `pool-fare.serializer.js` | One passenger's shared fare | Derived from one allocation, so no other fare can appear |
| `fare.serializer.js` | Solo quotes | Also owns `quoteRoundingScale` |
| `location.serializer.js`, `route.serializer.js`, `user.serializer.js` | The rest | |

## What a frontend should rely on

* Keys are **stable and additive**. A field is not renamed once published; when a
  better name exists the new one is added and the old one kept (see
  `servicePoint` and `currentServicePoint`, which are the same row).
* Times are UTC ISO-8601 strings or `null`. Never an epoch number, never a local
  string.
* A list is `{ data: [...], pagination: { limit, offset, returned, total, hasMore } }`.
* A single resource is the object itself. An "allowance" read is wrapped in the
  key it is about: `{ ride: … }`, `{ pool: … }`.
* Money is a string with the currency's scale (`"130.63"`), with `currency` beside
  it.

## Depends on / depended on by

Depends on `../services/*.rules.js` for the derived fields and
`../services/fare.calculator.js` for money. Depended on by `../controllers/`
(which choose one and send it) and by `test/unit/*.serializer.test.js`. Nothing in
`src/` may import from `test/`.

**A serializer is not allowed to query.** It is given rows; if it needs something
that was not loaded, the loader gains a field, not the serializer a query.
