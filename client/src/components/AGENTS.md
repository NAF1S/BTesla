# `client/src/components/` — the shared pieces

Three files of presentational primitives, and three folders of components that
actually do something. The split is the point: everything in *this* folder is a pure
function of its props, and everything that holds state, fetches or decides lives one
level down, under the role it belongs to.

| File | What it is |
| ---- | ---------- |
| `ui.js` | `PageShell`, `Heading`, `Panel`, `Button`, `LinkButton`, `Field`, `Select`, `Input`, `Notice`, `Facts` |
| `status-chip.js` | `Chip`, `RideStatusChip`, `Labeled`, `PlaceLine` |
| `async-state.js` | `Loading`, `EmptyState`, `ErrorState`, `ForbiddenState` |

| Folder | What lives there |
| ------ | ---------------- |
| `auth/` | Signing in and out — belongs to neither role. See `auth/AGENTS.md` |
| `passenger/` | The passenger's screens. See `passenger/AGENTS.md` |
| `driver/` | The driver's console. See `driver/AGENTS.md` |

## Why it matters

* **There is no component library, and adding one would be a dependency for a
  styling problem.** Tailwind is already here; these are the repeated combinations
  worth naming once, so a screen's markup reads as structure rather than as utility
  classes.
* **Nothing here knows about rides.** No component in this folder imports an API
  module, reads a context, or holds state. That is what makes them usable from a
  Server Component and a Client Component alike.
* **A component goes in a role folder, not in this one, the moment it knows anything.**
  The test is whether it would still make sense with the roles swapped: a `Panel`,
  a `Chip` and a `Loading` would, which is why they are here; a `RideStatusChip`
  would not, which is why it is a thin wrapper over `Chip` rather than a change to
  it.
* **The four async states are components, not conventions.** This client talks to a
  separate process over HTTP, so "the API is not running", "the seed is missing",
  "the session expired" and "not yours (404)" are ordinary occurrences rather than
  edge cases. Each of the four says what happened **and what to do about it** —
  a spinner with no caption and an error with no next step are the two shapes of
  "the app is broken" that are hardest to diagnose from outside.

## The rules these primitives encode

1. **`disabled` is applied to the element *and* the styling, never just the
   styling.** A submit button that looks live but does nothing is how a passenger
   clicks four times and creates four rides.
2. **A status chip looks up its tone in `ride-status.js`.** The same status is then
   the same colour on every screen, and an unrecognised status renders as a neutral
   chip showing the raw value instead of throwing. A status added by a later
   milestone should make a chip look plain, not break a page.
3. **`role="alert"` on error notices only.** An error should interrupt a screen
   reader; an informational note should not.
4. **`Facts` is a `<dl>`.** It is two label/value pairs per row, which is what it
   is, and it is what a screen reader announces correctly.

## What not to do here

* Do not add a component that fetches, polls or mutates. It belongs in
  `passenger/`, with `'use client'` at the top of its file.
* Do not give a primitive a "variant" that knows about the domain
  (`<Button rideAction="DEPART">`). Pass a label and a click handler; the domain
  knowledge belongs to the screen.
* Do not compute a state, a fare or a duration in a component. `ride-status.js` and
  `format.js` rename what the server sent; they never derive it.

## Depends on / depended on by

Depends on Tailwind via `../app/globals.css`, and on `../lib/ride-status.js` for
tone lookups. Depended on by every page in `../app/` and by every component in
`./passenger/`. Nothing here reads the session or the API.

## The Next.js version rule

`ui.js` imports `next/link`, so it is a Server Component by default and must stay
one. Read the bundled guide in `node_modules/next/dist/docs/` before changing
anything about rendering or data (`client/AGENTS.md` says where it lives).
