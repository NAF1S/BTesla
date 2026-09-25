# `client/src/` — the Next.js application

App Router, JavaScript (no TypeScript), Tailwind v4. Three directories:

| Directory | Holds |
| --------- | ----- |
| `app/` | The routes, the layout and the global styles — see `app/AGENTS.md` |
| `lib/` | The API client, the guard and the formatters — see `lib/AGENTS.md` |
| `components/` | The presentational primitives and the passenger screens — see `components/AGENTS.md` |

## Why it matters

This is the only client of the API in the repository. It implements the **passenger**
half of the product: sign in, choose two places, see a price, request a ride, watch
it. Everything else the server supports — driver availability, offers, the driver's
trip, pooling, history — is documented and tested on the server and has no screen
here yet.

That makes this directory the place where the API contract gets tested by use. When
something here is awkward to write, the contract is often the thing to fix.

## The one architectural decision, made once

**The guard is on the server, and the state machine stays there too.**

* Who is asking is resolved while the page renders (`lib/session.js`), so protected
  markup is never sent to a browser that should not have it.
* What a passenger may do next is read from the API (`stage`, `nextAction`), never
  derived. `lib/ride-status.js` renames those values for a screen and derives
  nothing; the components decide presentation, not rules.
* Interactive pieces are the smallest files that need to be: no `page.js` in `app/`
  is a client component.

## What not to do here

* **Do not compute state transitions in the client.** `allowedActions` (driver) and
  `nextAction` (passenger) are computed on the server from the state, so a button the
  server would refuse is never rendered. Reimplementing the rules in JavaScript is how
  the two drift apart.
* **Do not compute a fare.** Money is an exact decimal string from the API; the client
  displays it. `Number("130.63")` is a binary float and is how a paisa goes missing.
* **Do not read ids from anywhere but a previous response.** There is no user picker
  and no passenger id to send: every `/me` endpoint already knows who is asking.
* **Do not put the token in `localStorage`.** It is an HttpOnly cookie by design; the
  browser holds it and JavaScript never sees it.
* **Do not import `lib/session.js` from a client component.** It uses `next/headers`
  and will fail the build.
* **Do not add a font or a second styling system** without reading the Tailwind v4
  notes first: this Next version has breaking changes, and `client/AGENTS.md` says
  where to look.

## Depends on / depended on by

Depends on the server's HTTP API (proxied by `next.config.mjs`, see `lib/AGENTS.md`)
and on the seeded demo data — the sign-in accounts and the service points — for
anything to work. Depended on by nobody; the server has no compile-time relationship
with this directory.

## Commands

```bash
npm run dev            # both the API and the client, from the repository root
npm run dev:client     # just this
npm run lint           # the client is the only workspace with a lint script
npm run build          # from client/ — the only compile check the client has
```
