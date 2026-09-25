# `docker/db/` — the image definition

One file: `Dockerfile`. It extends the official PostGIS image with pgRouting and
nothing else.

```dockerfile
FROM postgis/postgis:17-3.5
# postgresql-17-pgrouting from the PostgreSQL apt repository
```

## Why it matters

Two extensions have to be present **before** any migration runs, because
`06-pgrouting-routing.sql` does `CREATE EXTENSION pgrouting` and every route in the
product depends on it:

| Extension | Used by |
| --------- | ------- |
| PostGIS | `service_points.location`, `routing_edges.geometry`, `ST_DWithin` in the dispatch shortlist, `ST_Length` in the seed checks |
| pgRouting | `pgr_dijkstra` — route estimation, fare legs, and every plan a pool is priced or matched on |

The tag is pinned (`17-3.5`) so a rebuild does not silently change the database
major version the migrations were written for.

## Depends on / depended on by

Depends on `postgis/postgis:17-3.5` and the PGDG apt repository. Depended on by
`../docker-compose.yml`, which builds this file into
`teslab/postgis-pgrouting:17-3.5` and runs it as the `db` service.

## Changing it

A change here needs a rebuild, not a restart:

```bash
docker compose up -d --build db
npm run db:migrate
npm test
```

The volume keeps its data, so an extension added to the image is available to the
running database only after the container is recreated — and `CREATE EXTENSION`
still has to run in a migration before anything can use it.
