# `client/src/components/passenger/` — the passenger's screens

Three components, all `'use client'`. This folder is the passenger's half of the
client, and it is deliberately the only passenger-side folder that imports
`lib/passenger-api.js`.

| File | What it is |
| ---- | ---------- |
| `sign-up-form.js` | Name, email, password -> `POST /auth/register` as a `PASSENGER` |
| `ride-request-panel.js` | Two locations -> a quote -> a ride request |
| `ride-tracker.js` | The current ride, polled every few seconds — and its outcome once it ends |

Signing in and out used to live here. They moved to `../auth/` when the driver's
screens arrived and needed them too: a person signs in **before** they are a
passenger or a driver, so those two components belong to neither folder. If you are
looking for `sign-in-form.js`, it is one level up.

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

## The tracker's polling

There is no push in this project, so polling is the honest transport. *How* to ask —
a recursive `setTimeout` rather than an interval, one request in flight, cancel on
unmount — lives in `../../lib/use-polling.js`, because the driver's console needs
exactly the same rules and two copies would drift.

*Whether* to keep asking is the tracker's own decision, and it is one case: the
endpoint answers with an *active* ride or nothing at all, so a ride that ends
arrives as `null` and there is nothing left to learn. That is what stops the loop,
and it is why "stop polling at completed or cancelled" needs no status check here.

The tracker's cadence differs from the driver console's in one respect: it **stops
entirely** in a background tab, because a ride nobody is looking at has nothing to
keep current. The console cannot do that — for a driver, reading the offers is what
keeps them dispatchable — so it slows down instead. Where the two disagree is exactly
where the shared hook takes a parameter.

Two more things the tracker does itself, both about honesty rather than traffic:

* **A failed poll keeps the last good ride.** The API being briefly unreachable is
  not the same as the ride disappearing, and blanking the screen would be a worse
  lie than a note saying the last update failed. A failure is therefore *not* a
  reason to stop asking either.
* **Times come from a client clock that starts as `null`.** The server renders the
  absolute time, the first client render agrees with it, and the relative age appears
  once the first poll has a clock. Rendering "58 seconds ago" on the server is a
  guaranteed hydration mismatch — see `../../lib/AGENTS.md`.

## `null` does not say which way it ended — so the tracker asks

`current-ride` returns active rides only. A ride that reached `COMPLETED` or
`CANCELLED` therefore arrives as `null`, and that response does not say which.

The tracker's answer is `getRideDetail`: the moment the active ride disappears it
reads the ride's own record once and reports the API's own `status`. That endpoint
has no status filter, so it settles a finished ride where the polling endpoint cannot.

This replaced an inference. The screen used to decide "completed" from the presence of
a drop-off timestamp on the last *active* read — usually right, and the sort of claim
that should not be guessed at the one moment somebody cares most. It also brings the
audience-filtered `timeline`, which is why the finished view lists events while the
live view lists instants.

## Depends on / depended on by

Depends on `../../lib/passenger-api.js` (fares, rides and the ride detail),
`../../lib/location-api.js` (the two place lists), `../../lib/format.js`,
`../../lib/ride-status.js` and `../../lib/use-polling.js`, plus `../ui.js`,
`../status-chip.js` and `../async-state.js` for markup. Depended on by
`../../app/{signup,ride,track}/page.js`.

**Never import `lib/session.js` from a file in this folder.** It uses
`next/headers` and only works on the server; a client component that imports it
fails to build.
