# `client/src/lib/` — the client's plumbing

Twelve modules, and the divisions between them are the whole point: what belongs to
a **person**, what belongs to a **role**, what belongs to **nobody**, and what is
only presentation.

| File | What it is | Runs |
| ---- | ---------- | ---- |
| `api.js` | The one `fetch` wrapper: base URL, cookie, body unwrapping, `ApiError` | both |
| `auth-api.js` | Sign in, sign up, sign out, "who am I" — role-independent | both |
| `roles.js` | The roles, and where each of them lives | both |
| `location-api.js` | Zones and service points — public reference data | both |
| `passenger-api.js` | Fares, ride requests, the current ride, one ride in detail, cancelling | both |
| `driver-api.js` | Availability, offers, the accepted pool, the six trip commands | both |
| `session.js` | The route guard, and the cookie reader | **server only** |
| `use-polling.js` | The polling policy, shared by both live screens | **client only** |
| `types.js` | The DTOs, as JSDoc typedefs | neither (types) |
| `format.js` | Money, distance, duration and instants, as text | both |
| `ride-status.js` | Names and tones for the **passenger's** states | both |
| `driver-status.js` | Names and tones for the **driver's** states | both |

## Why the half-dozen modules and not one

**A screen never builds a URL.** It asks `passenger-api.js` for "a quote between
these two points" or `driver-api.js` for "what am I being offered" and gets an
object or an `ApiError`. Paths, verbs, body shapes and header names live here.

But the three API modules are split by **who the caller is**, not by convenience:

* signing in is not a passenger activity — a person does it *before* they are one,
  and putting `signIn` in `passenger-api.js` would mean the driver's screens import
  the passenger's module to log in. That is why `auth-api.js` exists;
* picking a service point is not a passenger activity either — a driver comes
  online at one. It belongs to neither role, so it is `location-api.js`;
* and `roles.js` exists because three places need "where does this role belong" and
  they must not disagree: the server guard, the sign-in form (a client component,
  which cannot import the guard at all because it uses `next/headers`), and `/`.

## Why it matters

* **Two base URLs, and the difference is the auth cookie.** A Server Component calls
  the API directly through `API_URL` (`http://localhost:4000`) and forwards the
  incoming cookie by hand. A browser component uses `NEXT_PUBLIC_API_URL`, which is
  empty by default, so the request is same-origin to the Next server and
  `next.config.mjs` rewrites `/api/*` to the API. That rewrite is what makes the
  HttpOnly cookie work without CORS — and it is why `credentials: "include"` is set
  explicitly, so the client still works if the variable is pointed at the API.
* **The status code is kept, not collapsed into a message.** The API's message is
  written for a person, but the *status* is what the UI branches on: 401 is "your
  session ended", 403 is "this account is not the right role", 404 is "not found
  **or** not yours" — which the API deliberately makes the same — and 409 is "the
  state moved on, re-read it".

## The things a caller must get right

1. **`POST /ride-requests` needs an `Idempotency-Key` header** (8–128 characters),
   and it identifies one *intent*, not one attempt. A retry that generates a fresh
   key creates a second ride. `createRideRequest` takes the key from its caller for
   exactly this reason; `requestRide` derives one from the journey, so submitting
   the same two places twice is one ride.
2. **The list envelope is `{ data, pagination }`.** `readBody` unwraps `.data`, so a
   caller receives the array — use `pagination.hasMore`/`total` rather than guessing
   when to stop paging.
3. **"Nothing right now" is `200` with a null, not a `404`.** `current-ride` answers
   `{ ride: null }` and `current-pool` answers `{ pool: null }` when there is nothing
   to report — an available driver has no pool, and a passenger between rides has no
   ride. Treat both as ordinary states, never as errors: a poller that throws on them
   breaks the moment a journey ends.
4. **A quote is a resource, not a calculation.** `POST /fare-quotes` returns an
   immutable quote the passenger owns with an `expiresAt`; the ride request is
   created *from* it. A screen that has shown a price must submit that quote rather
   than asking for a fresh one.
5. **Accepting an offer takes no body.** The plan is the one stored when the offer
   was made, so there is nothing for a client to submit and nothing to edit. The
   endpoint posts an offer id and returns the pool.
6. **Reading the driver's offers is a side effect.** It refreshes `lastSeenAt`. Any
   driver screen that polls must poll the *offers*, not just the pool, or the driver
   silently ages out of dispatch after `DISPATCH_LOCATION_FRESHNESS_SECONDS`.

## The frontend-specific rules

* **Never compute a fare, a stage, a transition or a permission here.** The server
  publishes `stage`, `nextAction`, `allowedActions`, `canGoOnline`, `canGoOffline`
  and an offer's `expired` precisely so a client does not reimplement the rules.
  `ride-status.js` and `driver-status.js` *rename* those values; they derive nothing.
  If a screen needs a fact the DTO lacks, add it to the DTO.
* **"Nothing right now" is `200` with a null, and a finished ride needs a second
  question.** `current-pool` and `current-ride` answer `null` when there is nothing to
  report. That is an ordinary state — but for a finished ride it is *not* an answer:
  `getRideDetail` is what reports `COMPLETED` versus `CANCELLED`, and nothing should be
  inferred from the absence.
* **`format.js` does no arithmetic on money.** It appends the currency to the exact
  decimal string the API sent. `Number("130.63")` is a binary float and is how a
  paisa goes missing. Unit conversion (metres to "2.2 km") is presentation and is
  fine; where the API has already formatted a value, prefer theirs.
* **Times are formatted on the product's clock, in a fixed locale.** `formatTime` and
  `formatDateTime` pin `Asia/Dhaka` and `en-GB`. The timezone is the one the fare's
  rush-hour windows are defined in, so a screen cannot show an off-peak hour beside a
  peak price; the locale is pinned so the server's HTML and the browser's render are
  the same string. Leaving either to the machine is how a page gets a hydration
  mismatch and a visible flicker on every load.
* **`formatElapsed` is client-only, and its `now` is required.** "57 seconds ago" is
  a fact about when the function ran, so a server render and a client hydration can
  never agree on it. Pass a clock that starts as `null` and render an absolute time
  until there is one.
* **Everything a live screen needs to know about polling is in `use-polling.js`.**
  Recursive timeout rather than an interval, one request in flight, cancel on
  unmount — plus a cadence that can differ between the foreground and a background
  tab. Do not write an effect that calls `setState` on a timer; two copies of those
  six rules will drift.
* **Never cache a "current ride" or a "current pool".** They are the things a client
  polls, and a cached answer is a stale one. `apiFetch` sets `cache: "no-store"`.
* **`session.js` is server-only.** It imports `next/headers`; importing it from a
  client component fails the build. That is a feature — it is what keeps the guard
  off the browser.

## Depends on / depended on by

Depends on `next.config.mjs` (the `/api/*` rewrite), on `API_URL` /
`NEXT_PUBLIC_API_URL`, and on the API's DTOs as documented in
`server/openapi.yaml` — which is the machine-readable contract, and wins if
`types.js` disagrees. Depended on by everything under `../app/` and
`../components/`.

## The Next.js version rule

This version has breaking changes. Read the bundled guide in
`node_modules/next/dist/docs/` before writing or changing a data-fetching call —
`cache`, `fetch` options, `cookies()` and route conventions may not match older
Next.js. In this version `cookies()` and a page's `searchParams` are both
**asynchronous**.
