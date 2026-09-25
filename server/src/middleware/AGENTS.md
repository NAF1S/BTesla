# `server/src/middleware/` — who is asking

Three small modules mounted by `app.js` in this order: authentication, then the
API routes, then the 404, then the error handler.

## Why it matters

This is where the answer to "who is asking, and are they allowed?" is decided, and
the rules are deliberately blunt:

* **The token names a user; the role comes from the database.** `requireAuth`
  verifies the cookie, then loads the user row and rejects an inactive one. The
  JWT never carries a role, so a changed role or a deactivated account takes
  effect on the very next request rather than when the token expires.
* **Role checks are server-side, always.** `requireRole(DRIVER)` on a route is the
  authorization; hiding a button in a client is not.
* **The actor's profile id comes from the loaded record.**
  `requirePassengerProfileId` / `requireDriverProfileId` are the *only* way a
  service learns which passenger or driver is acting, and there is no request field
  anywhere that names one. That is what makes "a passenger can only read their own
  ride" a property of the type system rather than a check somebody has to remember.
* **One message for every unauthenticated outcome** (`"Authentication required"`),
  so nothing about why is revealed.
* **A database error never reaches a client.** `errorHandler.js` maps SQLSTATE and
  Prisma codes to statuses and replaces the driver's message with a stable one, and
  turns a `500` into a generic message in production.

## What is here

| File | Holds | Status codes it produces |
| ---- | ----- | ------------------------ |
| `auth.js` | `requireAuth`, `requireRole`, `currentUser`, `requirePassengerProfileId`, `requireDriverProfileId` | `401`, `403` |
| `errorHandler.js` | SQLSTATE / Prisma to HTTP, and the single `{ error: { message } }` shape | `400`, `404`, `409`, `500` |
| `notFound.js` | Anything that matched no route | `404` |

## What a frontend needs to know

```text
401  no cookie, an invalid one, an expired one, or a deactivated account
     -> send the user to the sign-in screen
403  authenticated, but the wrong role for this endpoint
     -> a UI bug: the client called a driver endpoint as a passenger
404  the resource is not there, OR it is not the caller's
     -> treat as "gone"; never as "try again differently"
```

**A 403 is never used for "not yours."** A resource that belongs to somebody else
answers `404`, so an id cannot be probed for existence. If you see a 403 on a
resource you believe you own, the role is wrong, not the id.

## Depends on / depended on by

Depends on `../utils/cookies.js`, `../utils/token.js`, `../services/user.service.js`
and `../utils/ApiError.js`. Depended on by `../app.js` (the global 404 and error
handler) and by every route file (the guards, mounted per route — which is what
makes an unknown path under a protected prefix a `404` rather than a `401`).

The two `requireXProfileId` helpers are also imported directly by the services, so
a service is safe to call outside the API — a fixture, a command, a test.
