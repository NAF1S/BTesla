# `server/src/utils/` — the small shared things

Pure helpers with no domain knowledge. If something here started knowing about
pools or fares, it would belong in `../services/`.

## Why it matters

Three of these modules are load-bearing for security and correctness, and a
frontend's assumptions rest on them.

| File | What it owns | Why it matters to a client |
| ---- | ------------ | -------------------------- |
| `validation.js` | `requireUuid`, `requireCode`, `requireIsoTimestamp`, `requireEnumValue`, `requireBoundedInteger`, `assertBodyKeys`, `assertQueryKeys`, … | Every 400 a client can receive is produced here, with a message naming the field and the accepted values. Unknown fields are **rejected**, so a typo surfaces instead of being ignored. |
| `ApiError.js` | `ApiError(statusCode, message, details)` | The one exception type the API throws deliberately. `errorHandler` turns it into `{ error: { message } }`. |
| `time.js` | Dhaka rush-hour windows and the traffic profile | Why the same journey can cost more at 17:00 than at noon. Half-open windows: the start minute is rush hour, the end minute is not. |
| `password.js`, `token.js`, `cookies.js` | bcrypt hashing, JWT sign/verify, the auth cookie | The cookie is HttpOnly, and the token carries a user id and nothing else — never a role. |
| `geo.js` | Coordinate helpers | Coordinates are stored **longitude-first**, as PostGIS expects. |

## The validation rules a client has to satisfy

```text
ids                uuid
codes              ^[a-z0-9][a-z0-9_-]{0,63}$   (input is trimmed and lower-cased first)
timestamps         ISO 8601 with an explicit offset or Z
                   "2026-09-25T12:17:06+06:00"   yes
                   "2026-09-25"                  no  (a day is not an instant)
                   "2026-09-25T12:17"            no  (no offset: which noon?)
enum values        matched case-insensitively, returned upper-cased
limit/offset       integers inside a bounded range; out of range is a 400, not a clamp
```

`assertQueryKeys` and `assertBodyKeys` are why `?passengerId=` is a `400` rather
than a silent ignore. That is deliberate: a client should learn that this API does
not work that way, and a reader of the code should not have to wonder whether an
ignored parameter once did something.

## Depends on / depended on by

Depends on nothing but `node:crypto`, `bcrypt` and `jsonwebtoken`. Depended on by
every controller (input), `../middleware/` (cookies, tokens, errors),
`../services/` (time, geo) and the tests, which exercise these directly
(`test/unit/validation.test.js`, `password.test.js`, `geo.test.js`).

Nothing here may import from `../services/` — that direction is one-way.
