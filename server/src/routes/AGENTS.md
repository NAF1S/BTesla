# `server/src/routes/` — URL shapes

One file per resource, each exporting an Express `Router` mounted under a prefix
by `index.js`. A route file is the **map of the API**: it says which paths exist,
which guards protect them, and which controller answers.

## Why it matters

This directory is the only place that decides what is addressable. Two rules are
enforced here rather than in the layers below, and both are load-bearing:

1. **Every path is mounted with its guard.** There is no path that reaches a
   controller without `requireAuth` (and `requireRole` where the role matters), and
   no path that names another user. `index.js` mounts the permission-checked
   routers, and a new file must do the same.
2. **A path that does not exist answers `404`, not `401`.** The guards are mounted
   *per route* rather than on a router, so an unknown path under a protected
   prefix is `notFound`, not "you are not logged in". That is why
   `/drivers/me/nonsense` is a 404 and `/drivers/me/availability` is a 401 without
   a cookie.

## What is here

| File | Mounted at | Holds |
| ---- | ---------- | ----- |
| `index.js` | `/api` | The mount table — **the list of every resource prefix** |
| `auth.routes.js` | `/api/auth` | register, login, me, logout |
| `user.routes.js` | `/api/users` | The demo user list (still public) |
| `location.routes.js` | `/api/location` | Zones and service points |
| `route.routes.js` | `/api/routes` | Route estimation |
| `fare.routes.js` | `/api/fare-quotes` | Solo fare quotes |
| `ride-request.routes.js` | `/api/ride-requests` | The passenger's request lifecycle |
| `passenger.routes.js` | `/api/passengers` | The passenger's reads: current ride, history, detail |
| `driver.routes.js` | `/api/drivers` | Availability, dispatch offers, the trip, driver reads |
| `docs.routes.js` | `/api/docs` | Serves `server/openapi.yaml` verbatim |
| `health.routes.js` | `/api/health` | Status, uptime, database probe |

## What a frontend needs from here

```text
Passenger app
  POST   /api/auth/login              -> sets the cookie, nothing else to store
  GET    /api/passengers/me/current-ride
  GET    /api/passengers/me/rides            ?status&from&to&limit&offset
  GET    /api/passengers/me/rides/:id
  POST   /api/ride-requests                  (Idempotency-Key header required)
  POST   /api/ride-requests/:id/cancel
  GET    /api/ride-requests/:id/fare
  POST   /api/fare-quotes
  GET    /api/location/points                ?zoneCode
  POST   /api/routes/estimate

Driver app
  PATCH  /api/drivers/me/availability        { online, servicePointCode|servicePointId }
  GET    /api/drivers/me/current-pool        -> allowedActions is the button list
  GET    /api/drivers/me/rides               ?status&from&to&limit&offset
  GET    /api/drivers/me/rides/:poolId
  GET    /api/drivers/me/offers              ?status
  POST   /api/drivers/me/offers/:id/accept   (no body)
  POST   /api/drivers/me/offers/:id/reject   { reason }
  POST   /api/drivers/me/pools/:poolId/{depart,start,complete}     (no body)
  POST   /api/drivers/me/pools/:poolId/stops/:stopId/arrive        (no body)
  POST   /api/drivers/me/pools/:poolId/stops/:stopId/members/:memberId/{pickup,dropoff}
```

**Never build a URL from a client-supplied id.** Every `/me` path already knows
who is asking. The only ids a client sends are ones the server gave it in a
previous response (`poolId`, `stopId`, `memberId`, `offerId`, `rideRequestId`), and
sending somebody else's is a 404.

## Depends on / depended on by

Depends on `../middleware/auth.js` (the guards) and `../controllers/` (the
handlers). Depended on by `../app.js`, which mounts this router at `/api`, and by
`test/unit/openapi.test.js`, which reads these files to check that
`server/openapi.yaml` documents every path that exists.

**Adding a route means updating `openapi.yaml`** — the test above fails otherwise,
on purpose.
