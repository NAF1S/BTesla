<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## What this client is, and is not

The **passenger** app: sign in, choose two places, see a price, request a ride, watch
it. Seven routes, all dynamic — `/` redirects, `/signin`, `/signup`, `/ride`,
`/track`, and `/status` (the scaffold's diagnostics page, kept because it is the only
screen that explains a broken environment).

There is **no driver UI, no pooling UI, no history screen, no map, no cancellation,
no payment and no admin screen**. The server supports all of those and documents
them; this client calls only the passenger endpoints it needs. Nothing here pushes:
polling is the transport.

Everything above the `END` marker is written and re-added by `next dev`; everything
below it is ours and survives regeneration.

* The server is the source of truth for what a passenger may do next. Do not compute
  a transition here: read `stage` and `nextAction` from
  `GET /api/passengers/me/current-ride` and render them.
* **That endpoint answers with an *active* ride only**, and `200 { ride: null }`
  otherwise. A ride that reached `COMPLETED` or `CANCELLED` therefore arrives as
  `null`, and the response does not say which. Do not guess; the ride-detail endpoint
  is a later milestone.
* The ride request is **quote-first**: `POST /api/fare-quotes` returns a quote the
  passenger owns, and `POST /api/ride-requests` is created *from* it with a required
  `Idempotency-Key` (8–128 characters, one per intent — not per attempt). A screen
  that has shown a price must submit that quote rather than quoting again.
* A `404` is the API's way of saying "not yours", so treat it as "gone", not as an
  error to surface. A `403` only ever means "this account is not a passenger".
* The guard runs on the **server** (`src/lib/session.js`); no `page.js` is a client
  component. `src/lib/session.js` must never be imported from one.
* Auth is the HttpOnly cookie from `POST /api/auth/login`; `src/lib/api.js` proxies
  `/api/*` through the Next rewrite, so browser requests are same-origin.

See `../README.md` (the API tables and
[The passenger's app](../README.md#the-passengers-app)) for the full contract, and
`src/AGENTS.md` for how the three directories divide the work.
