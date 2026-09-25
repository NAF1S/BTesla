# `server/prisma/` — the schema Prisma knows about

One file: `schema.prisma`. It is a **mirror** of `server/db/*.sql`, not its source.

## Why it matters

This is the part of the project most likely to confuse a newcomer, so it is worth
stating plainly:

* **The SQL files are authoritative.** `server/db/NN-*.sql` is applied by
  `npm run db:migrate` and creates the tables. `schema.prisma` exists so the
  application gets a typed client and so a drift check is possible.
* **Prisma Migrate is deliberately not used.** It cannot express what this schema
  depends on: the `CHECK` constraints that enforce the lifecycle rules, the
  partial unique indexes that decide the races, the GiST spatial indexes, and the
  triggers. So migrations stay hand-written and reviewable.
* **`prisma migrate diff` is a check, not a promise.** Run it and expect a specific,
  accepted set of differences:

  ```bash
  npx prisma migrate diff \
    --from-config-datasource ./prisma7.config.ts \
    --to-schema prisma/schema.prisma --script
  ```

  Five GiST spatial indexes are invisible to Prisma, three indexes are recreated
  without their `DESC` parts, and **every partial index is ignored entirely** (the
  four partial unique indexes, and the partial indexes the read APIs added). Any
  difference *outside* that list is a real drift and means the SQL and the schema
  have parted company.

* **Anything hand-written in SQL has to be mirrored here**, or the next person to
  read the schema will not know the column exists:

  | Change in `server/db/*.sql` | Also do |
  | --------------------------- | ------- |
  | `ADD COLUMN` | Add the field with the same `@map` name and column type |
  | `CREATE INDEX` (non-partial) | Add `@@index([...], map: "the_same_name")` |
  | `ALTER TYPE … ADD VALUE` | Add the enum value |
  | `CREATE UNIQUE INDEX` | Add `@@unique` only if it is not partial |

  A `@@index` whose name does not match the SQL produces a duplicate index on the
  next diff, which is why `map:` is always used.

## What a frontend indirectly depends on

Spelled-out guarantees the DTOs rest on:

* money is `Decimal(14, 6)` in `numeric` columns — hence strings in responses;
* `@db.Uuid` everywhere, so an id is a uuid and a malformed one is a `400` before
  it reaches the database;
* `@db.Timestamptz(6)` everywhere, so every instant is unambiguous and comes back
  as a UTC ISO string;
* enum labels are the exact strings a client sees (`WAITING`, `MATCHED`,
  `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `EXPIRED`, `FORMING`,
  `DRIVER_EN_ROUTE`, `ARRIVED`, `IN_PROGRESS`, `COMPLETED`, `ASSIGNED`,
  `PICKED_UP`, `DROPPED_OFF`, `PENDING`, `ARRIVED`, `COMPLETED`, `OFFLINE`,
  `AVAILABLE`, `RESERVED`, `ON_RIDE`). `openapi.yaml` documents them.

## Depends on / depended on by

Depends on `server/db/*.sql` describing the same database. Depended on by
`@prisma/client` (generated from it), by every service through `prisma`, and by
`prisma7.config.ts`, which resolves `DATABASE_URL` through `src/config/env.js`.

## Commands

```bash
npx prisma validate     --config prisma7.config.ts
npx prisma generate     --config prisma7.config.ts
npx prisma migrate diff --from-config-datasource ./prisma7.config.ts \
                        --to-schema prisma/schema.prisma --script
```
