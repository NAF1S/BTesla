# `docker/` — the container image for the database

One directory, one purpose: the PostgreSQL image the whole project runs on.

## Why it matters

The database is not a stock `postgres` container. The application needs three
extensions that do not ship together:

* **PostGIS** — the spatial column types and `ST_DWithin`, which is how dispatch
  shortlists nearby drivers;
* **pgRouting** — `pgr_dijkstra`, which every route, fare and trip plan is routed
  through;
* **PostgreSQL 17** — `gen_random_uuid()`, `ALTER TYPE … ADD VALUE`, and the
  constraint features the migrations use.

`docker/db/Dockerfile` builds `postgis/postgis:17-3.5` plus
`postgresql-17-pgrouting`, tagged `teslab/postgis-pgrouting:17-3.5`. The root
`docker-compose.yml` names it, so `npm run db:up` is all a developer needs — after
the first build.

## What is here

| File | What it is |
| ---- | ---------- |
| `db/Dockerfile` | The image: PostGIS 17 + pgRouting 3.8, and nothing else |

## Depends on / depended on by

Depends on the upstream `postgis/postgis:17-3.5` image and the PostgreSQL apt
repository. Depended on by `docker-compose.yml` (service `db`), and therefore by
everything: `npm run db:migrate`, `npm run db:seed`, `npm test` and the API all
assume it.

## The one thing that surprises people

The container is published on host port **55432**, not 5432. Ports 5432 and 5433
are taken on the development machine by a local PostgreSQL service and another
container, and silently connecting to the wrong database is worse than an
unusual port. `server/.env.example` and the fallback in `src/config/env.js` both
use 55432, so the API works with no configuration.

```bash
docker compose up -d --build db     # the first time, or after changing the image
npm run db:up                        # thereafter
docker exec teslab-db psql -U postgres -d TeslaB
```

The database is `TeslaB`, the user and password are `postgres`/`postgres`, and
`server/db/01-schema.sql` and `02-seed.sql` are mounted into
`docker-entrypoint-initdb.d` so a fresh volume is usable before any migration runs.
