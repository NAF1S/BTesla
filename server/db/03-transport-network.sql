-- ---------------------------------------------------------------------------
-- TeslaB transport network: zones, stops, corridors, ordered corridor stops
-- and directional travel estimates.
--
-- Conventions follow 01-schema.sql:
--   * UUID primary keys generated with pgcrypto's gen_random_uuid()
--   * snake_case columns and TIMESTAMPTZ created_at / updated_at audit columns
--   * every statement is idempotent, so this file can be re-applied by
--     `npm run db:migrate` and by the Postgres container's initdb hook
--
-- Storage decisions:
--   * money, distances and coordinates use NUMERIC -- never floating point
--     (float would corrupt money and distance comparisons)
--   * the ordered stop list of a corridor lives in corridor_stops (a real
--     table with a position column), never in a JSON blob, so ordering can be
--     indexed, constrained and joined
--   * travel_estimates is directional: (from_stop_id, to_stop_id) is a
--     separate record from (to_stop_id, from_stop_id)
--
-- This file creates structure only. Demo seed data is applied separately by
-- `npm run db:seed` (server/src/db/seeds/transport-network.*).
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Single shared trigger function that keeps updated_at honest on every UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Zones ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS zones (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT zones_code_format CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
);

CREATE INDEX IF NOT EXISTS zones_active_idx ON zones (active);

DROP TRIGGER IF EXISTS zones_set_updated_at ON zones;
CREATE TRIGGER zones_set_updated_at
  BEFORE UPDATE ON zones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Stops ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stops (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id    UUID NOT NULL REFERENCES zones (id) ON DELETE RESTRICT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  latitude   NUMERIC(9, 6),
  longitude  NUMERIC(9, 6),
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stops_code_format CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT stops_latitude_range CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CONSTRAINT stops_longitude_range CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);

-- "list stops in this zone" is the main stop lookup.
CREATE INDEX IF NOT EXISTS stops_zone_id_idx ON stops (zone_id);
CREATE INDEX IF NOT EXISTS stops_active_idx ON stops (active);

DROP TRIGGER IF EXISTS stops_set_updated_at ON stops;
CREATE TRIGGER stops_set_updated_at
  BEFORE UPDATE ON stops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Corridors -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corridors (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT corridors_code_format CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
);

CREATE INDEX IF NOT EXISTS corridors_active_idx ON corridors (active);

DROP TRIGGER IF EXISTS corridors_set_updated_at ON corridors;
CREATE TRIGGER corridors_set_updated_at
  BEFORE UPDATE ON corridors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Ordered corridor stops ----------------------------------------------------

-- Membership + ordering of a corridor. No surrogate id: the natural key is
-- (corridor_id, stop_id). A stop may appear at most once per corridor, and a
-- corridor position may hold at most one stop.
CREATE TABLE IF NOT EXISTS corridor_stops (
  corridor_id UUID NOT NULL REFERENCES corridors (id) ON DELETE CASCADE,
  stop_id     UUID NOT NULL REFERENCES stops (id) ON DELETE RESTRICT,
  position    INTEGER NOT NULL,
  PRIMARY KEY (corridor_id, stop_id),
  CONSTRAINT corridor_stops_position_positive CHECK (position > 0),
  CONSTRAINT corridor_stops_unique_position UNIQUE (corridor_id, position)
);

-- Supports "which corridors contain this stop?".
CREATE INDEX IF NOT EXISTS corridor_stops_stop_id_idx ON corridor_stops (stop_id);

-- Directional travel estimates ---------------------------------------------

CREATE TABLE IF NOT EXISTS travel_estimates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_stop_id          UUID NOT NULL REFERENCES stops (id) ON DELETE RESTRICT,
  to_stop_id            UUID NOT NULL REFERENCES stops (id) ON DELETE RESTRICT,
  estimated_minutes     INTEGER NOT NULL,
  estimated_distance_km NUMERIC(6, 2) NOT NULL,
  base_fare             NUMERIC(10, 2) NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'BDT',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One estimate per direction; A -> B and B -> A are two different rows.
  CONSTRAINT travel_estimates_unique_pair UNIQUE (from_stop_id, to_stop_id),
  CONSTRAINT travel_estimates_distinct_stops CHECK (from_stop_id <> to_stop_id),
  CONSTRAINT travel_estimates_minutes_positive CHECK (estimated_minutes > 0),
  CONSTRAINT travel_estimates_distance_positive CHECK (estimated_distance_km > 0),
  CONSTRAINT travel_estimates_fare_non_negative CHECK (base_fare >= 0),
  CONSTRAINT travel_estimates_currency_format CHECK (currency ~ '^[A-Z]{3}$')
);

-- The unique pair covers from_stop_id lookups; this one covers "what arrives
-- at this stop?".
CREATE INDEX IF NOT EXISTS travel_estimates_to_stop_id_idx ON travel_estimates (to_stop_id);

DROP TRIGGER IF EXISTS travel_estimates_set_updated_at ON travel_estimates;
CREATE TRIGGER travel_estimates_set_updated_at
  BEFORE UPDATE ON travel_estimates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
