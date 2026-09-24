# ---------------------------------------------------------------------------
# Database image for TeslaB: PostgreSQL 17 + PostGIS 3.5 + pgRouting.
#
# The upstream `postgis/postgis` image ships PostGIS but NOT pgRouting, so
# `CREATE EXTENSION pgrouting` would fail on it ("could not open extension
# control file"). This adds exactly one package to the same base image, which
# keeps the PostgreSQL major version (17) unchanged -- the existing
# `teslab-pgdata` volume therefore keeps working and no data is migrated.
#
# `--no-install-recommends` keeps the layer small, and the apt lists are removed
# so the build does not bloat the image with repository metadata.
#
# Build/run it through compose (see docker-compose.yml):
#
#     docker compose up -d --build db
#
# The base image already configures the PGDG apt repository (see
# /etc/apt/sources.list.d/pgdg.list), which is where postgresql-17-pgrouting
# comes from. Building therefore needs network access to apt.postgresql.org.
# ---------------------------------------------------------------------------
FROM postgis/postgis:17-3.5

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-17-pgrouting \
    && rm -rf /var/lib/apt/lists/*
