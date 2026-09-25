# `client/src/components/auth/` — signing in, signing out

Two components, and they are the only ones in this client that belong to **nobody
in particular**.

| File | What it is |
| ---- | ---------- |
| `sign-in-form.js` | Email and password -> `POST /auth/login`, then the role's home |
| `sign-out-button.js` | -> `POST /auth/logout`, then `/signin` |

## Why these are here and not in `passenger/` or `driver/`

A person signs in **before** they are a passenger or a driver. The API has one
login endpoint, one cookie, and one DTO; the role only matters once it has
answered. Putting `signIn` under `passenger/` would mean the driver's screens
import the passenger's module to log in — which is exactly backwards, and the
first thing a reviewer would ask about.

The same argument moved the identity calls out of `passenger-api.js` and into
`lib/auth-api.js`, and it is why `lib/roles.js` exists: "a driver belongs at
`/driver`" is needed by this form (a client component) and by the server guard,
and neither can import the other.

## The rule this folder exists to keep

**The role comes from the API's answer, never from the form.** There is no role
selector, and there is nothing in the request body that says "sign me in as". The
form posts credentials, reads `user.role` off the reply, and asks `homeForRole`
where that belongs. A selector would be a way to ask for a session you should not
have.

`next` still wins over the role's home, because "the screen you asked for" is more
specific than "the screen for your role" — that is what makes the guard's redirect
back to `/track` work.

## Sign-out is deliberately boring

The API clears the cookie and answers `204`, and it does not require a valid
token, so signing out works on an expired session and is safe to retry. A failure
is swallowed on purpose: the redirect happens either way, and the guard at
`/signin` is the thing that decides what is true. There is nothing to invalidate
client-side because there is nothing stored client-side — the cookie *was* the
session.

## What not to do here

* Do not add a role selector, or accept a role from anywhere but the API's answer.
* Do not import `lib/session.js`. It uses `next/headers` and only works on the
  server; a client component that imports it fails to build. `lib/roles.js` is the
  part of that knowledge a browser may have.
* Do not store the session. There is no token to store; the cookie is HttpOnly.

## Depends on / depended on by

Depends on `../../lib/auth-api.js`, `../../lib/roles.js` and `../ui.js`. Depended
on by `../../app/signin/page.js` and `../../app/layout.js` (which renders the
sign-out control in the header for both roles).
