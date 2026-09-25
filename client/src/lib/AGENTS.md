# `client/src/lib/` — the client's plumbing

Six modules. Two of them touch the network, two are for the server only, and two
turn machine values into something a person reads.

| File | What it is | Runs |
| ---- | ---------- | ---- |
| `api.js` | The one `fetch` wrapper: base URL, cookie, body unwrapping, `ApiError` | both |
| `passenger-api.js` | Every backend call these screens make, one function each | both |
| `session.js` | The route guard, and the cookie reader | **server only** |
| `types.js` | The DTOs, as JSDoc typedefs | neither (types) |
| `format.js` | Money, distance, duration and instants, as text | both |
| `ride-status.js` | Names and tones for the states the server decided | both |

## Why it matters

* **Two base URLs, and the difference is the auth cookie.** A Server Component calls
  the API directly through `API_URL` (`http://localhost:4000`) and forwards the
  incoming cookie by hand. A browser component uses `NEXT_PUBLIC_API_URL`, which is
  empty by default, so the request is same-origin to the Next server and
  `next.config.mjs` rewrites `/api/*` to the API. That rewrite is what makes the
  HttpOnly cookie work without CORS — and it is why `credentials: "include"` is set
  explicitly, so the client still works if the variable is pointed at the API.
* **A screen never builds a URL.** A component asks `passenger-api.js` for "the
  zones" or "a quote between these two points" and gets an object or an `ApiError`.
  Paths, verbs, body shapes and header names live here.
* **The status code is kept, not collapsed into a message.** The API's message is
  written for a person, but the *status* is what the UI branches on: 401 is "your
  session ended", 403 is "this account is not a passenger", 404 is "not found **or**
  not yours" — which the API deliberately makes the same — and 409 is "the state
  moved on, re-read it".

## The things a caller must get right

1. **`POST /ride-requests` needs an `Idempotency-Key` header** (8–128 characters),
   and it identifies one *intent*, not one attempt. A retry that generates a fresh
   key creates a second ride. `createRideRequest` takes the key from its caller for
   exactly this reason; `requestRide` derives one from the journey, so submitting
   the same two places twice is one ride.
2. **The list envelope is `{ data, pagination }`.** `readBody` unwraps `.data`, so a
   caller receives the array — use `pagination.hasMore`/`total` rather than guessing
   when to stop paging.
3. **`current-ride` answers `200 { ride: null }`, not a 404**, when the passenger is
   not riding, and it answers with *active* rides only. Treat "no ride" as an
   ordinary state, never as an error — a poller that throws on it breaks the moment a
   ride finishes.
4. **A quote is a resource, not a calculation.** `POST /fare-quotes` returns an
   immutable quote the passenger owns with an `expiresAt`; the ride request is
   created *from* it. A screen that has shown a price must submit that quote rather
   than asking for a fresh one.

## The frontend-specific rules

* **Never compute a fare, a stage or a state transition here.** `ride-status.js`
  renames `DRIVER_EN_ROUTE` to "Driver on the way"; it derives nothing. The server
  publishes `stage`, `nextAction` and `allowedActions` precisely so a client does not
  reimplement the rules. If a screen needs a fact the DTO lacks, add it to the DTO.
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
* **Never cache a "current ride".** It is the one thing a client polls, and a cached
  answer is a stale one. `apiFetch` sets `cache: "no-store"` for that reason.
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
