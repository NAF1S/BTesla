# `client/src/components/driver/` — the driver's screens

Three components, all `'use client'`, and one of them is the screen.

| File | What it is |
| ---- | ---------- |
| `driver-console.js` | The screen: availability, offers, the pool, and the polling that ties them together |
| `availability-panel.js` | The online/offline control and the driver's own state |
| `offer-card.js` | One offer, with accept and decline |
| `current-pool-panel.js` | The ride in progress: the plan, the passengers, and the buttons that drive it |

## The console owns the state; the panels are functions of it

Every action here moves several values at once. Accepting a ride creates a pool,
flips the driver to `RESERVED` and closes the offer; dropping a passenger off
delivers that member *and* opens `COMPLETE_TRIP`; completing hands the driver back to
`AVAILABLE` and ends the pool. So `driver-console.js` holds `availability`, `offers`
and `pool`, and the other files are handed what they render.

Every command therefore **re-reads** rather than patching the local copy: one button
can move three parts of the screen, and the server is the only thing that knows the
whole answer.

## An action failure is reported where it happened

`actionError` carries a `scope`, so a refused offer is not announced under "Could not
change your availability", and a refused trip command is not announced under either.
Naming the wrong cause is worse than saying nothing.

## Driving a ride: the buttons are the server's list

`current-pool-panel.js` renders **one button per entry in `allowedActions`** and
decides nothing itself. That list arrives with the pool and is computed by the same
rules the commands consult, so it is never stale and never optimistic.

The rule to keep is short: **there is no lifecycle in this folder.** No
`if (pool.status === "FORMING")`, no "is the passenger aboard yet", no ordering of
the six commands. Two reasons it matters more here than anywhere else:

* a client-side lifecycle is a second copy of the state machine with none of the
  server's tests, and its failure mode is a button that answers `409` — or, worse, a
  legal action that is never offered because the copy is out of date;
* the states are not one-per-action. Immediately after collecting a passenger the
  server allows **two** commands at once (`ARRIVE_AT_STOP` **and** `START_TRIP`), so a
  panel that rendered "the next action" would silently drop one. The list is
  rendered whole, in the order it arrives, and the heading switches between "What to
  do next" and "What you can do now" to match.

Two supporting facts make the buttons work:

* **`nextStop` is where they point.** The server publishes it as "the lowest-sequence
  stop that is not done, and the only stop they may serve", and `driver-api.js`
  resolves the stop id — and the member id — from it. So the button and the request
  cannot disagree about which stop is meant.
* **`TRIP_ACTION` supplies wording, not permission.** It says a button reading
  `ARRIVE_AT_STOP` should be "Arrive at" + the place, and `PICKUP_PASSENGER` "Pick up"
  + the first name. Whether the action is *allowed* was settled before the name
  arrived.

## The heartbeat is the reason this screen polls

## Why there is no "move me" control

`PUT /drivers/me/current-service-point` exists and is valid while the driver is
offline or available, but the availability DTO publishes no boolean for "may I
move". Drawing the button would mean reimplementing `canSetCurrentServicePoint`
here, so it is left to the milestone that adds the field. Relocating means going
offline and coming back online somewhere else — two clicks, and no new rule.

## Depends on / depended on by

Depends on `../../lib/driver-api.js` (which owns every URL, and resolves a trip
action's ids), `../../lib/driver-status.js` for labels, `../../lib/ride-status.js`
for the pool and stop vocabulary that both sides share, `../../lib/use-polling.js`
for the polling policy, and `../ui.js` / `../status-chip.js` / `../async-state.js`
for markup. Depended on by `../../app/driver/page.js`.

**Never import `lib/session.js` here.** It uses `next/headers` and only works on the
server; a client component that imports it fails to build.
