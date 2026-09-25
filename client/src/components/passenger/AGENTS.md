# `client/src/components/passenger/` — the screens that do something

Four components, all `'use client'`. This is the only folder in the client that
holds state, and it is deliberately the only one that imports
`lib/passenger-api.js`.

| File | What it is |
| ---- | ---------- |
| `sign-in-form.js` | Email and password -> `POST /auth/login` |
| `sign-up-form.js` | Name, email, password -> `POST /auth/register` |
| `sign-out-button.js` | -> `POST /auth/logout`, then back to `/signin` |
| `ride-request-panel.js` | Two locations -> a quote -> a ride request |
| `ride-tracker.js` | The current ride, polled every few seconds |

## Why these are client components and the pages are not

A page that must know who is asking is guarded on the **server** (`lib/session.js`),
so the protected markup is never shipped to a browser that should not see it. Only
the pieces that collect input or poll are client components. `'use client'` belongs
on the smallest file that needs it — never on a page, and never on a primitive in
`../`.

## The four rules

1. **No product rule lives here.** The fare is whatever the API returned; a ride's
   `stage` and `nextAction` are computed on the server from the ride's own
   timestamps; `allowedActions` is a server decision. `ride-status.js` renames those
   values for a screen and does nothing else. The mistake to avoid is
   `if (status === "MATCHED" && !departedAt)` — that is a second, weaker copy of the
   state machine, with none of the server's tests. If a screen needs something the
   DTO does not carry, the fix is a field in the DTO.
2. **Identity is never sent.** No call here takes a passenger id, because no
   endpoint accepts one. The HttpOnly cookie identifies the caller and every `/me`
   path resolves it on the server.
3. **The request panel submits the quote it is *showing*.** A quote is priced at an
   instant by a traffic profile, so quoting again at submit time can return a
   different number from the one on screen. The panel therefore calls `quoteFare`
   and then `createRideRequest` with that `quoteId` — it does **not** use the
   one-shot `requestRide`, which exists for the case where nothing has been quoted
   yet. The `Idempotency-Key` is created beside the quote and kept until the journey
   changes, so a retry of one submission is the same intent and only one ride is
   created.
4. **Money is a string.** `formatMoney` appends the currency and nothing else;
   `Number("130.63")` is a binary float and is how a paisa goes missing. No component
   adds up a fare.

## The tracker's polling, and why it is shaped that way

There is no push in this project, so polling is the honest transport. How it is done
is the interesting part, and each decision is load-bearing:

* **A recursive `setTimeout`, not `setInterval`.** An interval lets a slow request
  stack up behind the next tick, so the screen shows the answer to a question asked
  four polls ago. This waits for the reply before scheduling the next question.
* **It stops when the ride is over**, because `GET /passengers/me/current-ride`
  answers with an *active* ride or nothing at all. A ride that ends arrives as
  `null`, and there is nothing left to learn.
* **It pauses on a hidden tab** and re-checks the moment the tab becomes visible —
  a background tab does not need four requests a minute, but the passenger looking
  at it again should not be up to an interval behind.
* **A failed poll keeps the last good ride.** The API being briefly unreachable is
  not the same as the ride disappearing, and blanking the screen would be a worse
  lie than a note saying the last update failed.
* **The timer is cleared and a flag set on unmount**, so a slow reply cannot
  `setState` on a component that is gone.
* **Times come from a client clock that starts as `null`.** The server renders the
  absolute time, the first client render agrees with it, and the relative age appears
  once the first poll has a clock. Rendering "58 seconds ago" on the server is a
  guaranteed hydration mismatch — see `../../lib/AGENTS.md`.

## `null` does not say which way it ended

`current-ride` returns active rides only. A ride that reached `COMPLETED` or
`CANCELLED` therefore arrives as `null`, and the response does **not** say which.
The tracker shows "this ride is no longer active" and the last things it knew.
Calling it completed or cancelled would be a guess about somebody's money; the
answer needs the ride-detail endpoint, which is a later milestone.

## Depends on / depended on by

Depends on `../../lib/passenger-api.js` (which owns every URL), `../../lib/format.js`
and `../../lib/ride-status.js` for presentation, and `../ui.js`,
`../status-chip.js`, `../async-state.js` for markup. Depended on by
`../../app/{signin,signup,ride,track}/page.js` and by `../../app/../layout.js`.

**Never import `lib/session.js` from a file in this folder.** It uses
`next/headers` and only works on the server; a client component that imports it
fails to build.
