# `client/src/app/` — the routes

Next.js **App Router**. A folder is a URL segment; a `page.js` in it is the
renderable route.

| File | URL | What it is |
| ---- | --- | ---------- |
| `layout.js` | — | The root layout: `<html>`, fonts, and the header with the role's navigation |
| `page.js` | `/` | A redirect, and nothing else |
| `signin/page.js` | `/signin` | Sign-in for **both roles** — sends each to its own home |
| `signup/page.js` | `/signup` | Passenger sign-up |
| `ride/page.js` | `/ride` | Pick two places, see the price, request the ride |
| `track/page.js` | `/track` | The passenger's current ride, polled |
| `driver/page.js` | `/driver` | The driver's console: availability, offers, and the ride in progress |
| `status/page.js` | `/status` | The scaffold's diagnostics page: is the API up, and who is seeded? |
| `globals.css` | — | The Tailwind v4 entry point |

## Why it matters

* **Every page here is dynamic, and that is not an oversight.** The layout reads the
  cookie jar, so it already knows who is asking; the protected pages check again
  themselves. Next reports all eight routes as `ƒ (Dynamic) server-rendered on
  demand` — there is nothing to cache, because every screen is about one person and
  one moment.
* **The guard is on the server.** `lib/session.js` refuses *before* any HTML exists,
  so a signed-out visitor never receives protected markup and nobody can read it out
  of developer tools. A client-side guard (`if (!user) router.replace("/signin")`)
  always ships the screen first and takes it away after.
* **`page.js` is a Server Component by default.** It can `await` data and it never
  ships to the browser. Interactivity needs `'use client'` on the smallest file that
  needs it — which is why no `page.js` in this folder has it.

## The decisions these routes encode

1. **`/` is a redirect, not a screen.** Its destination comes from `homeForRole` —
   the one mapping in `lib/roles.js` — and falls through to `/signin`; when the API
   itself cannot be reached it goes to `/status`, because that is the one page that
   can explain *why* nothing loaded and what to start.
2. **A signed-in user who opens the wrong half is sent to their own home, not to the
   sign-in form.** `requireRole` redirects a driver who lands on `/ride` to
   `/driver`, and a passenger who lands on `/driver` to `/ride`. This is the rule
   that has to be right in a two-role client: sending them to `/signin` would show a
   form they would immediately submit, only to be sent back — a loop. The `denied`
   banner on the sign-in screen is now only for a role with **no** home here (an
   `ADMIN`).
3. **`/ride` sends a passenger who is already riding to `/track`.** Without it they
   would fill in the form and be told afterwards, by a `409`, that they already have
   an active request. Learning that before the form is better than after. The check is
   best-effort: if the API is down the page still renders and the panel reports it.
4. **`/track` does *not* redirect when there is no ride.** A passenger whose ride just
   ended should see that it ended, not be bounced to the request screen — which is
   where the "request another ride" button on that very message goes.
5. **`/driver` reads everything before it renders.** Availability, offers and the
   pool in parallel, so the console's first paint is real state rather than three
   spinners — and a failure is *not* swallowed, because the availability read is what
   the entire screen is about. What the console does handle is a failure that happens
   later, while the driver is watching.
6. **The two auth pages read `searchParams` and pass it down as props.** `next` is the
   redirect target the guard remembered; `denied` is the role it refused. Reading them
   once on the server avoids `useSearchParams()` in a client component, which would
   need a `Suspense` boundary and would render the form twice.

## What is deliberately not here

No history screen, no map, no cancellation, no payment and no admin route — the
server supports all of it and the client does not call it yet.

The two halves are otherwise complete for an MVP: a passenger can request a ride and
watch it, and a driver can accept one and drive it to the end. What is *not* here is
any client-side idea of how a ride progresses — the driver's buttons are the server's
`allowedActions` and the passenger's stage is the server's `stage`, so neither screen
holds a state machine.

## Depends on / depended on by

Depends on `../lib/session.js` for the guards and `../lib/roles.js` for the homes,
`../lib/passenger-api.js` and `../lib/driver-api.js` for data, `../components/**` for
markup, and Tailwind via `globals.css`. Depended on by nothing else in the client.

`npm run lint` and `npm run build` (from `client/`) are the automated checks the
client has — there is no frontend test suite yet.

## The Next.js version rule

This version has breaking changes, and its APIs may not match what you remember.
`client/AGENTS.md` says where the bundled docs live
(`node_modules/next/dist/docs/`); read the relevant guide before writing routing,
data-fetching or caching code. In this version `cookies()` and a page's
`searchParams` are both **Promises**.
