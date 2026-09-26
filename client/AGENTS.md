<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## What this client is, and is not

**Both halves of the loop**: a passenger asks for a ride, a driver accepts it, the
passenger's screen changes. Eight routes, all dynamic — `/` redirects, `/signin`,
`/signup`, `/ride`, `/track`, `/driver`, and `/status` (the scaffold's diagnostics
page, kept because it is the only screen that explains a broken environment).

There is **no history screen, no map, no cancellation, no payment and no admin
screen**. The server supports all of those and documents them; this client calls only
the endpoints it needs. Nothing here pushes: polling is the transport.

Everything above the `END` marker is written and re-added by `next dev`; everything
below it is ours and survives regeneration.

**Two roles, one client.** A person signs in once; the role the API reports decides
which half they get — `/ride` and `/track` for a passenger, `/driver` for a driver.
Someone signed in as the other role is redirected to their own home rather than to
the sign-in form, because a form they would immediately re-submit is a loop.
`src/lib/roles.js` holds that one mapping.

* The server is the source of truth for what either role may do next. Do not compute
  a transition, a permission or a fare here — read `stage` and `nextAction`
  (passenger), `canGoOnline`, `canGoOffline` and an offer's `expired` (driver), and
  render the driver's trip controls one-for-one from `allowedActions`.
* **`current-ride` answers with an *active* ride only**, and `200 { ride: null }`
  otherwise — so a finished ride arrives as `null` and does not say whether the
  passenger arrived or was cancelled on. The tracker asks
  `GET /passengers/me/rides/:id` at that moment, which has no status filter, rather
  than inferring anything from the absence.
* **The six trip commands take no body** — every identifier is in the path, and
  idempotency is state, not a key: sending one twice returns the state it produced the
  first time. A `409` means the ride moved on while the page was stale; re-read it.
* **Cancelling is a passenger write, and only from `WAITING`.** The ride DTO publishes
  `cancellable`, true exactly then, and the endpoint refuses anything else with a
  `409`. Render the control from that flag rather than from `status`.
* The ride request is **quote-first**: `POST /api/fare-quotes` returns a quote the
  passenger owns, and `POST /api/ride-requests` is created *from* it with a required
  `Idempotency-Key` (8–128 characters, one per intent — not per attempt). A screen
  that has shown a price must submit that quote rather than quoting again.
* **Reading the driver's offers is a heartbeat.** `lastSeenAt` is refreshed when a
  driver goes online, moves, reads their offers, or answers one, and a location older
  than `DISPATCH_LOCATION_FRESHNESS_SECONDS` (300 s) drops them out of dispatch. So
  the console polls `/me/offers` — in a background tab too, at a slower cadence — and
  does not poll at all while offline.
* **Accepting an offer sends no body.** The plan is the one stored when the offer was
  made. The endpoint posts an offer id and renders the pool that comes back. An offer
  that is somebody else's is a `404`, the same as one that does not exist.
* A `404` is the API's way of saying "not yours", so treat it as "gone", not as an
  error to surface. A `403` only ever means "this account is not allowed here".
* The guard runs on the **server** (`src/lib/session.js`); no `page.js` is a client
  component. `src/lib/session.js` must never be imported from one — which is why the
  role mapping lives in `src/lib/roles.js`, where both sides can reach it.
* Auth is the HttpOnly cookie from `POST /api/auth/login`; `src/lib/api.js` proxies
  `/api/*` through the Next rewrite, so browser requests are same-origin. There is no
  token to store, and no `localStorage` in the client.

See `../README.md` (the API tables,
[The passenger's app](../README.md#the-passengers-app) and
[The driver's console](../README.md#the-drivers-console)) for the full contract, and
`src/AGENTS.md` for how the three directories divide the work.
