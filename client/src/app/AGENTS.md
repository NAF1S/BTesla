# `client/src/app/` — the routes

Next.js **App Router**. A folder is a URL segment; a `page.js` in it is the
renderable route.

| File | URL | What it is |
| ---- | --- | ---------- |
| `layout.js` | — | The root layout: `<html>`, fonts, and the header with the sign-out control |
| `page.js` | `/` | A redirect, and nothing else |
| `signin/page.js` | `/signin` | Sign-in — sends a signed-in passenger to `/ride` |
| `signup/page.js` | `/signup` | Sign-up — the same redirect in the opposite direction |
| `ride/page.js` | `/ride` | Pick two places, see the price, request the ride |
| `track/page.js` | `/track` | The current ride, polled |
| `status/page.js` | `/status` | The scaffold's diagnostics page: is the API up, and who is seeded? |
| `globals.css` | — | The Tailwind v4 entry point |

## Why it matters

* **Every page here is dynamic, and that is not an oversight.** The layout reads the
  cookie jar, so it already knows who is asking; the protected pages check again
  themselves. Next reports all seven routes as `ƒ (Dynamic) server-rendered on
  demand` — there is nothing to cache, because every screen is about one passenger
  and one moment.
* **The guard is on the server.** `lib/session.js` refuses *before* any HTML exists,
  so a signed-out visitor never receives protected markup and nobody can read it out
  of developer tools. A client-side guard (`if (!user) router.replace("/signin")`)
  always ships the screen first and takes it away after.
* **`page.js` is a Server Component by default.** It can `await` data and it never
  ships to the browser. Interactivity needs `'use client'` on the smallest file that
  needs it — which is why no `page.js` in this folder has it.

## The four decisions these routes encode

1. **`/` is a redirect, not a screen.** Three destinations: a signed-in passenger to
   `/ride`, anybody else to `/signin`, and — when the API cannot be reached —
   `/status`, because that is the one page that can explain *why* nothing loaded and
   what to start.
2. **`/ride` sends a passenger who is already riding to `/track`.** Without it they
   would fill in the form and be told afterwards, by a `409`, that they already have
   an active request. Learning that before the form is better than after. The check is
   best-effort: if the API is down the page still renders and the panel reports it.
3. **`/track` does *not* redirect when there is no ride.** A passenger whose ride
   just ended should see that it ended, not be bounced to the request screen — which
   is where the "request another ride" button on that very message goes.
4. **The two auth pages read `searchParams` and pass it down as props.** `next` is
   the redirect target the guard remembered; `denied` is the role it refused. Reading
   them once on the server avoids `useSearchParams()` in a client component, which
   would need a `Suspense` boundary and would render the form twice.

## What is deliberately not here

No driver screen, no pooling screen, no history screen, no map, no cancellation, no
payment and no admin route. Those are later milestones; the API for several of them
already exists and the client does not call it yet. The header links to the two
screens that do exist, because a link to a screen that does not is worse than no link.

## Depends on / depended on by

Depends on `../lib/session.js` for the guard, `../lib/passenger-api.js` for data,
`../components/**` for markup, and Tailwind via `globals.css`. Depended on by
nothing else in the client.

`npm run lint` and `npm run build` (from `client/`) are the automated checks the
client has — there is no frontend test suite yet.

## The Next.js version rule

This version has breaking changes, and its APIs may not match what you remember.
`client/AGENTS.md` says where the bundled docs live
(`node_modules/next/dist/docs/`); read the relevant guide before writing routing,
data-fetching or caching code. In this version `cookies()` and a page's
`searchParams` are both **Promises**.
