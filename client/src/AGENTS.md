# `client/src/` — the Next.js application

App Router, JavaScript (no TypeScript), Tailwind v4. Three directories:

| Directory | Holds |
| --------- | ----- |
| `app/` | The routes, the layout and the global styles — see `app/AGENTS.md` |
| `lib/` | The API modules, the guard, the polling hook and the formatters — see `lib/AGENTS.md` |
| `components/` | The presentational primitives, and one folder per role — see `components/AGENTS.md` |

## Why it matters

This is the only client of the API in the repository, and it now covers **both halves
of the loop**: a passenger requests a ride, a driver accepts it, and the passenger's
screen changes.

| Half | Screens |
| ---- | ------- |
| Passenger | sign up, choose two places, see a price, request a ride, watch it to its outcome |
| Driver | sign in, go online, answer an offer, drive the ride to the end |

For an MVP both halves are now complete: the passenger requests, the driver accepts
and drives, and the passenger's screen follows along to `completed`.

What is missing is deliberate: history, maps, cancellation, payment and anything
administrative. The server supports all of it and is tested for it; the client does
not call it yet.

That makes this directory the place where the API contract gets tested by use. When
something here is awkward to write, the contract is often the thing to fix.

## The two architectural decisions, made once

**The guard is on the server, and it is role-aware.**

* Who is asking is resolved while the page renders (`lib/session.js`), so protected
  markup is never sent to a browser that should not have it. `requireRole` takes the
  role the screen is for.
* Someone signed in **as the other role** is sent to their own home, not to the
  sign-in form. That matters more than it sounds: sending a signed-in driver to
  `/signin` would show a form they would immediately submit, only to be sent
  back — a loop. `lib/roles.js` holds the single mapping that the guard, the sign-in
  form and `/` all use.

**The state machine stays on the server.**

* What a passenger may do next is read from the API (`stage`, `nextAction`), and what
  a driver may do is read from it too (`canGoOnline`, `canGoOffline`, `expired`,
  `allowedActions`). `lib/ride-status.js` and `lib/driver-status.js` rename those
  values for a screen and derive nothing. The driver's trip controls are rendered
  from `allowedActions` one-for-one, which is why the screen has no idea what a
  `FORMING` pool is.
* Where a screen has to decide *which control to draw*, it uses a published fact —
  `online` — rather than a status it would have to interpret. Where the fact it needs
  is missing ("may I move?" has no boolean), the control is left out and the DTO gap
  is documented rather than guessed at.
* Interactive pieces are the smallest files that need to be: no `page.js` in `app/`
  is a client component.

## What not to do here

* **Do not compute state transitions, permissions or fares in the client.**
  `allowedActions` (driver), `nextAction` (passenger), `canGoOnline` / `canGoOffline`
  and an offer's `expired` are computed on the server from the state, so a button the
  server would refuse is never rendered. Reimplementing the rules in JavaScript is how
  the two drift apart.
* **Do not compute a fare.** Money is an exact decimal string from the API; the client
  displays it. `Number("130.63")` is a binary float and is how a paisa goes missing.
* **Do not read ids from anywhere but a previous response.** There is no user picker
  and no passenger or driver id to send: every `/me` endpoint already knows who is
  asking.
* **Do not put the token in `localStorage`.** It is an HttpOnly cookie by design; the
  browser holds it and JavaScript never sees it.
* **Do not import `lib/session.js` from a client component.** It uses `next/headers`
  and will fail the build.
* **Do not write your own polling loop.** `lib/use-polling.js` holds the rules, and
  the two live screens differ only in the cadence they pass it.
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
