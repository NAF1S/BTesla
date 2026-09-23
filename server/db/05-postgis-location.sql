-- ---------------------------------------------------------------------------
-- PostGIS location foundation.
--
--   service_zones    -> the 15 Dhaka service zones
--   routing_vertices -> graph nodes (a routing concern, not a passenger one)
--   service_points   -> curated pickup/drop-off locations passengers may use
--   routing_edges    -> the stored, directed graph between those vertices
--
-- ---------------------------------------------------------------------------
-- COORDINATE ORDER
-- ---------------------------------------------------------------------------
-- Every coordinate here is WGS84 / SRID 4326, and PostGIS constructors take
-- LONGITUDE FIRST:
--
--     ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
--
-- Reversing them is not an error PostGIS will catch for you -- it silently
-- stores a point in the wrong hemisphere. See server/src/utils/geo.js, which
-- only ever builds points from a named { latitude, longitude } pair.
--
-- Conventions follow 01-schema.sql: UUID keys from pgcrypto's gen_random_uuid(),
-- snake_case columns, TIMESTAMPTZ created_at / updated_at, and a BEFORE UPDATE
-- trigger keeping updated_at honest.
--
-- Idempotent: this file is re-applied by `npm run db:migrate`.
-- ---------------------------------------------------------------------------

-- 1. PostGIS -----------------------------------------------------------------
--
-- Requires a role that may create extensions. The docker-compose database runs
-- as the `postgres` superuser, so this succeeds out of the box; on a managed
-- PostgreSQL service the extension is usually enabled from the provider's
-- console instead, and this statement then becomes a no-op.
--
-- pgRouting is deliberately NOT installed in this phase: the graph is stored
-- here, but pathfinding is deferred.
CREATE EXTENSION IF NOT EXISTS postgis;

-- The shared trigger function used to live in the transport-network migration,
-- which has been removed. Recreated here because every table below needs it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. service_zones -----------------------------------------------------------
--
-- `code` is the stable machine-readable key the seed upserts by, so it must not
-- change when a display `name` changes -- which is why names are free to be
-- edited while codes are treated as a contract.
--
-- WARNING about the two range checks below. A `geography` value in SRID 4326 is
-- NORMALISED on input: casting an out-of-range point does not raise, it is
-- silently corrected (latitude 95 becomes 85, longitude 190 becomes -170). So
-- those checks assert a property of what is already stored rather than
-- rejecting a bad input, and they cannot actually fail. Rejecting an
-- out-of-range coordinate has to happen BEFORE the cast, which is exactly what
-- src/utils/geo.js does for every value this project writes.
-- See location.schema.integration.test.js, which pins this behaviour.
CREATE TABLE IF NOT EXISTS service_zones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL UNIQUE,
  active          BOOLEAN NOT NULL DEFAULT true,
  -- Demo centroid of the zone's seeded points, not a surveyed boundary.
  center_location GEOGRAPHY(POINT, 4326) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_zones_code_format CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT service_zones_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT service_zones_longitude_range CHECK (ST_X(center_location::geometry) BETWEEN -180 AND 180),
  CONSTRAINT service_zones_latitude_range CHECK (ST_Y(center_location::geometry) BETWEEN -90 AND 90)
);

CREATE INDEX IF NOT EXISTS service_zones_active_idx ON service_zones (active);
CREATE INDEX IF NOT EXISTS service_zones_center_location_idx
  ON service_zones USING GIST (center_location);

DROP TRIGGER IF EXISTS service_zones_set_updated_at ON service_zones;
CREATE TRIGGER service_zones_set_updated_at
  BEFORE UPDATE ON service_zones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. routing_vertices --------------------------------------------------------
--
-- A vertex is a graph node. It is intentionally separate from a ServicePoint:
-- ServicePoints are the passenger-facing places people get in and out, while
-- vertices are what a future router walks between. In this seed they are
-- one-to-one, which keeps the graph easy to reason about, but the separation is
-- what will later allow several points to share one junction.
--
-- `geometry(Point, 4326)` rather than `geography`, matching the brief: edges
-- are measured with ST_Length(geometry::geography) where metre accuracy matters.
CREATE TABLE IF NOT EXISTS routing_vertices (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL UNIQUE,
  location   GEOMETRY(POINT, 4326) NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT routing_vertices_code_format CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT routing_vertices_longitude_range CHECK (ST_X(location) BETWEEN -180 AND 180),
  CONSTRAINT routing_vertices_latitude_range CHECK (ST_Y(location) BETWEEN -90 AND 90)
);

CREATE INDEX IF NOT EXISTS routing_vertices_active_idx ON routing_vertices (active);
CREATE INDEX IF NOT EXISTS routing_vertices_location_idx
  ON routing_vertices USING GIST (location);

DROP TRIGGER IF EXISTS routing_vertices_set_updated_at ON routing_vertices;
CREATE TRIGGER routing_vertices_set_updated_at
  BEFORE UPDATE ON routing_vertices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4. service_points ----------------------------------------------------------
--
-- routing_vertex_id is NOT NULL from the start. The brief allows a nullable
-- column during migration, but these tables are brand new and therefore empty,
-- so there is no legacy row needing a two-phase backfill.
--
-- (zone_id, name) is unique so a zone cannot contain the same place twice;
-- `code` is globally unique because it is the stable seed key and the public
-- identifier.
--
-- The longitude/latitude range checks carry the same caveat as on service_zones:
-- `geography` normalises out-of-range input, so they document the stored value
-- rather than validate the input. Validation lives in src/utils/geo.js.
CREATE TABLE IF NOT EXISTS service_points (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id           UUID NOT NULL REFERENCES service_zones (id) ON DELETE RESTRICT,
  routing_vertex_id UUID NOT NULL REFERENCES routing_vertices (id) ON DELETE RESTRICT,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  location          GEOGRAPHY(POINT, 4326) NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_points_code_format CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT service_points_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT service_points_longitude_range CHECK (ST_X(location::geometry) BETWEEN -180 AND 180),
  CONSTRAINT service_points_latitude_range CHECK (ST_Y(location::geometry) BETWEEN -90 AND 90),
  CONSTRAINT service_points_zone_name_unique UNIQUE (zone_id, name)
);

CREATE INDEX IF NOT EXISTS service_points_zone_id_idx ON service_points (zone_id);
CREATE INDEX IF NOT EXISTS service_points_routing_vertex_id_idx ON service_points (routing_vertex_id);
CREATE INDEX IF NOT EXISTS service_points_active_idx ON service_points (active);
-- Covers "active points in this zone", the main lookup shape.
CREATE INDEX IF NOT EXISTS service_points_zone_active_idx ON service_points (zone_id, active);
-- The spatial index the brief requires, used by ST_DWithin proximity queries.
CREATE INDEX IF NOT EXISTS service_points_location_idx
  ON service_points USING GIST (location);

DROP TRIGGER IF EXISTS service_points_set_updated_at ON service_points;
CREATE TRIGGER service_points_set_updated_at
  BEFORE UPDATE ON service_points
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5. routing_edges -----------------------------------------------------------
--
-- Distance is NOT hand-written: the seed sets it from
-- ST_Length(geometry::geography), and the constraint below keeps it honest.
--
-- Direction rules:
--   * a directed edge permits travel from source to target;
--   * bidirectional = true  -> reverse_*_duration_seconds must be present;
--   * bidirectional = false -> reverse_*_duration_seconds must be NULL.
--
-- Whether the geometry actually starts near its source and ends near its target
-- cannot be a CHECK constraint (it needs to read another row), so that is
-- validated by the seed and by the graph tests instead.
CREATE TABLE IF NOT EXISTS routing_edges (
  id                                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                               TEXT NOT NULL UNIQUE,
  source_vertex_id                   UUID NOT NULL REFERENCES routing_vertices (id) ON DELETE RESTRICT,
  target_vertex_id                   UUID NOT NULL REFERENCES routing_vertices (id) ON DELETE RESTRICT,
  geometry                           GEOMETRY(LINESTRING, 4326) NOT NULL,
  distance_meters                    NUMERIC(12, 2) NOT NULL,
  normal_duration_seconds            INTEGER NOT NULL,
  rush_hour_duration_seconds         INTEGER NOT NULL,
  fare_weight                        NUMERIC(6, 3) NOT NULL DEFAULT 1,
  reverse_normal_duration_seconds    INTEGER,
  reverse_rush_hour_duration_seconds INTEGER,
  bidirectional                      BOOLEAN NOT NULL DEFAULT false,
  active                             BOOLEAN NOT NULL DEFAULT true,
  metadata                           JSONB,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT routing_edges_code_format CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  -- A self-loop means nothing without a pathfinding requirement for one.
  CONSTRAINT routing_edges_no_self_loop CHECK (source_vertex_id <> target_vertex_id),
  -- A LineString needs at least two points.
  CONSTRAINT routing_edges_line_has_two_points CHECK (ST_NPoints(geometry) >= 2),
  CONSTRAINT routing_edges_distance_positive CHECK (distance_meters > 0),
  -- Keeps the stored distance equal to the geometry it came from (1 m tolerance
  -- absorbs the NUMERIC(12,2) rounding).
  CONSTRAINT routing_edges_distance_matches_geometry
    CHECK (abs(distance_meters - ST_Length(geometry::geography)) <= 1),
  CONSTRAINT routing_edges_normal_duration_positive CHECK (normal_duration_seconds > 0),
  CONSTRAINT routing_edges_rush_duration_positive CHECK (rush_hour_duration_seconds > 0),
  -- Rush hour is slower, never quicker.
  CONSTRAINT routing_edges_rush_not_faster
    CHECK (rush_hour_duration_seconds >= normal_duration_seconds),
  CONSTRAINT routing_edges_fare_weight_positive CHECK (fare_weight > 0),
  CONSTRAINT routing_edges_reverse_durations_consistent CHECK (
    (
      bidirectional
      AND reverse_normal_duration_seconds IS NOT NULL
      AND reverse_rush_hour_duration_seconds IS NOT NULL
      AND reverse_normal_duration_seconds > 0
      AND reverse_rush_hour_duration_seconds >= reverse_normal_duration_seconds
    )
    OR (
      NOT bidirectional
      AND reverse_normal_duration_seconds IS NULL
      AND reverse_rush_hour_duration_seconds IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS routing_edges_source_vertex_id_idx ON routing_edges (source_vertex_id);
CREATE INDEX IF NOT EXISTS routing_edges_target_vertex_id_idx ON routing_edges (target_vertex_id);
CREATE INDEX IF NOT EXISTS routing_edges_active_idx ON routing_edges (active);
CREATE INDEX IF NOT EXISTS routing_edges_geometry_idx ON routing_edges USING GIST (geometry);

DROP TRIGGER IF EXISTS routing_edges_set_updated_at ON routing_edges;
CREATE TRIGGER routing_edges_set_updated_at
  BEFORE UPDATE ON routing_edges
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
