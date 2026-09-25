# `server/src/controllers/` — the HTTP edge

One file per resource, exporting async `(req, res)` handlers. A controller does
four things and nothing else: **reads and validates the request, calls one
service, chooses a DTO, sends a status code.**

## Why it matters

A controller is where a request stops being untrusted. Everything after it works
with values the server has already validated and with an identity it has already
resolved.

* **Validation happens here, before the database.** `utils/validation.js` turns a
  bad uuid, an unknown status, an unparseable date or an unexpected field into a
  `400` with a helpful message. `assertQueryKeys` / `assertBodyKeys` reject
  *unknown* fields, so `?passengerId=` is a 400 rather than a silent no-op — which
  is both a better error and the reason "this API cannot address another user" is
  true of the query string as well as the body.
* **The actor comes from the session.** `currentUser(req)` is the user
  `requireAuth` loaded from the database. **No controller reads an actor id from
  the request**, so there is nothing to tamper with.
* **One service call per handler.** A controller that starts orchestrating is a
  service in the wrong place. The two exceptions are explicit and commented: the
  post-commit re-assignment after a creation or a refusal, and the re-assignment
  after a departure cancels join offers.
* **No business rule lives here.** If a handler contains an `if` about a status
  transition, that rule belongs in a `*.rules.js` module.

## What is here

| File | Holds |
| ---- | ----- |
| `passenger.controller.js` | The passenger's three reads: current ride, history, detail |
| `ride-request.controller.js` | The request lifecycle, the fare, and the `trip` block |
| `driver.controller.js` | Availability, offers, the trip commands, the driver's reads |
| `auth.controller.js`, `user.controller.js` | Accounts and the demo user list |
| `location.controller.js`, `route.controller.js` | Places and route estimation |
| `fare.controller.js` | Solo quotes |

## What a frontend needs to know

* Status codes are meaningful and consistent per endpoint; each controller's header
  comment lists its own. The shared ones: `400` malformed, `401` no session,
  `403` wrong role, `404` not found **or not yours**, `409` conflicts with the
  current state.
* Error shape is always `{ error: { message } }`, and a 403 always means "wrong
  role" — never "not yours". A resource that is not the caller's is a `404`.
* A command that has already succeeded answers `200` with the state it produced,
  so a retry is safe. There is no `409` for "you already did this".

## Depends on / depended on by

Depends on `../services/` (the domain), `../serializers/` (the response),
`../middleware/auth.js` (the actor) and `../utils/validation.js` (the input).
Depended on by `../routes/`, which decides who may reach each handler.

## Rules worth preserving

* Never `res.json` a database row. Pick a serializer.
* Never catch a database error to translate it; `middleware/errorHandler.js`
  already maps SQLSTATE and Prisma codes to statuses and replaces their messages
  with stable ones.
* A handler that asserts `assertBodyKeys(body, [])` means "this endpoint takes no
  body at all" — sending one is a 400, deliberately.
