# `client/src/components/driver/` — the driver's screens

Three components, all `'use client'`, and one of them is the screen.

| File | What it is |
| ---- | ---------- |
| `driver-console.js` | The screen: availability, offers, the pool, and the polling that ties them together |
| `availability-panel.js` | The online/offline control and the driver's own state |
| `offer-card.js` | One offer, with accept and decline |
| `current-pool-panel.js` | The ride the driver has just accepted |

## Why the console owns the state

Every action here moves all three values at once. Accepting a ride creates a pool,
flips the driver to `RESERVED`, and closes the offer — so the panel and the cards
cannot own their own copies without three things disagreeing about the same
moment. `driver-console.js` holds `availability`, `offers` and `pool`, and the
other three are functions of what they are handed.

## The rules

1. **No product rule lives here.** `canGoOnline`, `canGoOffline`, an offer's
   `expired`, and the pool's `allowedActions` are all computed on the server, by the
   same rules the write endpoints consult. The mistake to avoid is
   `disabled={status !== "AVAILABLE"}` — that is a second copy of `canGoOffline`
   with none of the server's tests. If a screen needs a fact the DTO lacks, the fix
   is a field in the DTO. (`availability-panel.js` names the one control that is
   missing for exactly this reason.)
2. **Which control is drawn comes from a published fact, not a derived rule.**
   `online` is the DTO's own boolean and decides whether the panel offers a place to
   come online at or a way back out. `canGoOnline` is true in *two* states, so it
   cannot make that choice; using it would draw "Go online" for a driver the
   endpoint would refuse.
3. **Identity is never sent.** No call takes a driver id. The only identifier a
   driver's client ever sends is an offer id — and somebody else's offer is a `404`,
   the same as one that does not exist, so it cannot be used to probe.
4. **Acceptance takes no body.** The plan the driver accepts is the one stored when
   the offer was made, so there is nothing to submit and nothing to edit. The
   endpoint posts an offer id and renders the pool that comes back.
5. **An action failure is reported where it happened.** `actionError` carries a
   `scope`, so a refused offer is not announced under "Could not change your
   availability". Naming the wrong cause is worse than saying nothing.

## The heartbeat is the reason this screen polls

`lastSeenAt` is refreshed when a driver goes online, moves, **reads their offers**,
or answers one. A location older than `DISPATCH_LOCATION_FRESHNESS_SECONDS`
(300 s) drops them out of dispatch, because a location that cannot be trusted is not
one the server can promise a passenger.

So polling `/me/offers` is not just how the driver learns about a ride — it is the
only signal this project has that a driver is still at the wheel. Two consequences
that are easy to get wrong:

* the console polls **in a background tab too**, at a slower cadence. A driver with
  the screen in the background is still driving, and stopping would quietly drop
  them out of dispatch after five minutes;
* it polls **only while `online`**. An offline driver has nothing to learn and does
  not need to prove they are there.

(The passenger's tracker does the opposite — it *stops* when the ride is over — which
is why `lib/use-polling.js` takes a cadence rather than hard-coding one.)

## Why there is no "move me" or trip control

Neither is an oversight:

* `PUT /drivers/me/current-service-point` exists and is valid while the driver is
  offline or available, but the DTO publishes no boolean for "may I move". Drawing
  the button would mean reimplementing `canSetCurrentServicePoint` here, so it is
  left to the milestone that adds the field. Relocating means going offline and
  coming back online somewhere else.
* The six trip commands — set off, arrive, collect, start, drop off, finish — belong
  to the next milestone. The pool summary *shows* `allowedActions`, in words, so the
  driver learns what the server says comes next without the client pretending it can
  do it.

## Depends on / depended on by

Depends on `../../lib/driver-api.js` (which owns every URL), `../../lib/driver-status.js`
for labels, `../../lib/ride-status.js` for the pool and stop vocabulary that both
sides share, `../../lib/use-polling.js` for the polling policy, and
`../ui.js` / `../status-chip.js` / `../async-state.js` for markup. Depended on by
`../../app/driver/page.js`.

**Never import `lib/session.js` here.** It uses `next/headers` and only works on the
server; a client component that imports it fails to build.
