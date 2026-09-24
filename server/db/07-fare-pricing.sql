-- ---------------------------------------------------------------------------
-- Solo-fare pricing: versioned fare policies and immutable fare quotes.
--
--   fare_policies -> versioned, effective-dated pricing configuration (BDT)
--   fare_quotes   -> an immutable, auditable record of one quoted price
--
-- ---------------------------------------------------------------------------
-- WHERE THE MONEY LIVES
-- ---------------------------------------------------------------------------
-- Every monetary column is `numeric`, never `double precision` / `real`. Binary
-- floating point cannot represent 0.10 exactly, so a fare built from it is a
-- fare nobody can reproduce; PostgreSQL numeric is exact decimal. The
-- application side matches: all arithmetic goes through decimal.js (Prisma's
-- bundled `Decimal`), and no money value ever passes through a JavaScript
-- `number`.
--
-- Precision is deliberately generous on storage and tight on presentation:
--
--   fare_policies  numeric(12,4)  -- rates are configuration, and 4 decimals is
--                                    enough for a sub-paisa rate step
--   fare_quotes    numeric(14,6)  -- a quote stores what the policy's
--                                    `rounding_scale` produced (0-6 decimals)
--
-- The fare is *presented* at `rounding_scale` decimals (2 by default, the
-- conventional money format), which is a formatting decision made once, at the
-- end, in the serializer -- not a storage decision.
--
-- ---------------------------------------------------------------------------
-- VERSIONING
-- ---------------------------------------------------------------------------
-- A policy is identified by (code, version). Changing how fares are calculated
-- means inserting a new version, never editing one that quotes already point at:
-- a trigger below refuses exactly that, because a quote must stay explainable
-- for as long as it exists. Rows are selected by the instant they are effective
-- for, so history stays intact.
--
-- Idempotent: this file is re-applied by `npm run db:migrate`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Enums
-- PostgreSQL has no CREATE TYPE IF NOT EXISTS, so this is guarded by catalog,
-- the same way 04-auth.sql does it. Prisma maps `traffic_profile` onto the
-- TrafficProfile enum in server/prisma/schema.prisma.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'traffic_profile') THEN
    CREATE TYPE traffic_profile AS ENUM ('NORMAL', 'RUSH_HOUR');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. fare_policies
--
-- One row is one *version* of one pricing policy. Nothing here is per-ride
-- state: this is configuration, and it is the only place a rate may come from.
--
-- Constraints are the point of the table. A rate that is negative, a multiplier
-- that is zero or negative, a TTL that is not positive, a rounding scale
-- outside 0-6, a currency that is not a 3-letter code, or an effective window
-- that ends before it starts would each produce a wrong or unanswerable fare, so
-- each is refused by the database rather than left to a code path to remember.
--
-- `effective_from` is NOT NULL and `effective_to` is nullable: an open-ended
-- policy is the normal case, and a closed window is how a retired version is
-- pinned in time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fare_policies (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                      TEXT NOT NULL,
  version                   INTEGER NOT NULL,
  name                      TEXT NOT NULL,
  currency                  TEXT NOT NULL DEFAULT 'BDT',
  base_fare                 NUMERIC(12, 4) NOT NULL,
  per_kilometer_rate        NUMERIC(12, 4) NOT NULL,
  per_minute_rate           NUMERIC(12, 4) NOT NULL,
  minimum_fare              NUMERIC(12, 4) NOT NULL,
  normal_traffic_multiplier NUMERIC(6, 4) NOT NULL DEFAULT 1.0000,
  rush_hour_multiplier      NUMERIC(6, 4) NOT NULL,
  quote_ttl_seconds         INTEGER NOT NULL,
  rounding_scale            SMALLINT NOT NULL DEFAULT 2,
  active                    BOOLEAN NOT NULL DEFAULT true,
  effective_from            TIMESTAMPTZ NOT NULL,
  effective_to              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- (code, version) is the identity of a policy: `dhaka-solo` v1 and v2 are
  -- different prices, and re-running the seed must not create a third.
  CONSTRAINT fare_policies_code_version_unique UNIQUE (code, version),
  CONSTRAINT fare_policies_code_format CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT fare_policies_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT fare_policies_version_positive CHECK (version > 0),
  -- ISO 4217 shape, and (for this single-currency MVP) the one currency the
  -- product quotes in. A second currency needs a migration, on purpose.
  CONSTRAINT fare_policies_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT fare_policies_currency_supported CHECK (currency = 'BDT'),
  CONSTRAINT fare_policies_base_fare_non_negative CHECK (base_fare >= 0),
  CONSTRAINT fare_policies_per_kilometer_rate_non_negative CHECK (per_kilometer_rate >= 0),
  CONSTRAINT fare_policies_per_minute_rate_non_negative CHECK (per_minute_rate >= 0),
  CONSTRAINT fare_policies_minimum_fare_non_negative CHECK (minimum_fare >= 0),
  -- A multiplier of zero would make every ride free; a negative one would pay
  -- the passenger. Both are configuration errors, not prices.
  CONSTRAINT fare_policies_multipliers_positive
    CHECK (normal_traffic_multiplier > 0 AND rush_hour_multiplier > 0),
  CONSTRAINT fare_policies_quote_ttl_positive CHECK (quote_ttl_seconds > 0),
  -- 0 is whole-taka rounding, 6 is the widest a fare_quotes column can hold.
  CONSTRAINT fare_policies_rounding_scale_range CHECK (rounding_scale BETWEEN 0 AND 6),
  CONSTRAINT fare_policies_effective_window_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Answers "which version is effective at this instant?" for one code.
CREATE INDEX IF NOT EXISTS fare_policies_code_active_effective_from_idx
  ON fare_policies (code, active, effective_from);

DROP TRIGGER IF EXISTS fare_policies_set_updated_at ON fare_policies;
CREATE TRIGGER fare_policies_set_updated_at
  BEFORE UPDATE ON fare_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. fare_policies: a quoted version is frozen
--
-- A quote records the policy version it was calculated from, so a policy that
-- has been quoted must keep producing the same answer forever. This refuses an
-- UPDATE that would change any calculation input on such a policy.
--
-- Deliberately *not* frozen: `name`, `active`, `effective_from`, `effective_to`
-- and `quote_ttl_seconds`. Retiring a version, renaming it or shortening the TTL
-- of future quotes changes no historical number -- retiring a version is in fact
-- how it gets replaced.
--
-- The remedy is always the same: insert the next version.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_referenced_fare_policy_change() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fare_quotes q WHERE q.fare_policy_id = OLD.id) THEN
    IF (NEW.code, NEW.version, NEW.currency, NEW.base_fare, NEW.per_kilometer_rate,
        NEW.per_minute_rate, NEW.minimum_fare, NEW.normal_traffic_multiplier,
        NEW.rush_hour_multiplier, NEW.rounding_scale)
       IS DISTINCT FROM
       (OLD.code, OLD.version, OLD.currency, OLD.base_fare, OLD.per_kilometer_rate,
        OLD.per_minute_rate, OLD.minimum_fare, OLD.normal_traffic_multiplier,
        OLD.rush_hour_multiplier, OLD.rounding_scale)
    THEN
      RAISE EXCEPTION
        'fare policy % version % has been quoted: create a new version instead of editing it',
        OLD.code, OLD.version
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fare_policies_frozen_once_quoted ON fare_policies;
CREATE TRIGGER fare_policies_frozen_once_quoted
  BEFORE UPDATE ON fare_policies
  FOR EACH ROW EXECUTE FUNCTION prevent_referenced_fare_policy_change();

-- ---------------------------------------------------------------------------
-- 4. fare_quotes
--
-- One row is one price, quoted at a moment, for one journey, under one policy
-- version. It is written once and never updated: the columns are the inputs and
-- the outputs of the fare formula, so the row can be re-derived and audited long
-- after the policy has been superseded.
--
-- Three constraints make the stored arithmetic self-checking, which is what
-- "auditable" has to mean in practice:
--
--   * pre_traffic_subtotal = base_fare + distance_fare + time_fare
--   * final_fare           = GREATEST(minimum_fare, subtotal + adjustment)
--   * minimum_fare_applied = the minimum actually won
--
-- A row that fails any of them cannot be written, so a future quote can never be
-- stored with a breakdown that does not add up.
--
-- `route_snapshot` and `fare_breakdown` are JSONB because they are
-- document-shaped: the ordered per-edge audit trail and the component-by-component
-- breakdown. Money inside them is stored as decimal *strings*, matching the
-- columns, so nothing is re-parsed through a float.
--
-- No passenger, user or RideRequest relationship exists in this phase. A later
-- milestone adds the request that accepts a quote; the quote itself stays as it
-- is, which is why the FK to fare_policies is ON DELETE RESTRICT -- deleting
-- pricing that a quote depends on would break the audit trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fare_quotes (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_service_point_id      UUID NOT NULL REFERENCES service_points (id) ON DELETE RESTRICT,
  destination_service_point_id UUID NOT NULL REFERENCES service_points (id) ON DELETE RESTRICT,
  departure_at                 TIMESTAMPTZ NOT NULL,
  estimated_arrival_at         TIMESTAMPTZ NOT NULL,
  traffic_profile              traffic_profile NOT NULL,
  distance_meters              INTEGER NOT NULL,
  duration_seconds             INTEGER NOT NULL,
  fare_policy_id               UUID NOT NULL REFERENCES fare_policies (id) ON DELETE RESTRICT,
  pricing_code                 TEXT NOT NULL,
  pricing_version              INTEGER NOT NULL,
  currency                     TEXT NOT NULL,
  base_fare                    NUMERIC(14, 6) NOT NULL,
  distance_fare                NUMERIC(14, 6) NOT NULL,
  time_fare                    NUMERIC(14, 6) NOT NULL,
  pre_traffic_subtotal         NUMERIC(14, 6) NOT NULL,
  traffic_multiplier           NUMERIC(14, 6) NOT NULL,
  traffic_adjustment           NUMERIC(14, 6) NOT NULL,
  minimum_fare                 NUMERIC(14, 6) NOT NULL,
  minimum_fare_applied         BOOLEAN NOT NULL,
  final_fare                   NUMERIC(14, 6) NOT NULL,
  route_snapshot               JSONB NOT NULL,
  fare_breakdown               JSONB NOT NULL,
  expires_at                   TIMESTAMPTZ NOT NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fare_quotes_endpoints_differ
    CHECK (origin_service_point_id <> destination_service_point_id),
  CONSTRAINT fare_quotes_distance_positive CHECK (distance_meters > 0),
  CONSTRAINT fare_quotes_duration_positive CHECK (duration_seconds > 0),
  CONSTRAINT fare_quotes_arrival_not_before_departure
    CHECK (estimated_arrival_at >= departure_at),
  -- A quote lives from the moment it is created until its TTL runs out.
  CONSTRAINT fare_quotes_expires_after_creation CHECK (expires_at > created_at),
  CONSTRAINT fare_quotes_pricing_version_positive CHECK (pricing_version > 0),
  CONSTRAINT fare_quotes_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT fare_quotes_amounts_non_negative CHECK (
    base_fare >= 0
    AND distance_fare >= 0
    AND time_fare >= 0
    AND traffic_adjustment >= 0
    AND minimum_fare >= 0
    AND final_fare >= 0
  ),
  CONSTRAINT fare_quotes_multiplier_positive CHECK (traffic_multiplier > 0),
  CONSTRAINT fare_quotes_subtotal_consistent
    CHECK (pre_traffic_subtotal = base_fare + distance_fare + time_fare),
  CONSTRAINT fare_quotes_total_consistent CHECK (
    final_fare = GREATEST(minimum_fare, pre_traffic_subtotal + traffic_adjustment)
    AND minimum_fare_applied = (minimum_fare > pre_traffic_subtotal + traffic_adjustment)
  )
);

-- Expiry sweeps and "is this quote still usable?" reads.
CREATE INDEX IF NOT EXISTS fare_quotes_expires_at_idx ON fare_quotes (expires_at);
-- "Which quotes came from this policy version?" -- the audit direction.
CREATE INDEX IF NOT EXISTS fare_quotes_fare_policy_id_idx ON fare_quotes (fare_policy_id);
-- Newest-first listings.
CREATE INDEX IF NOT EXISTS fare_quotes_created_at_idx ON fare_quotes (created_at);
-- "Has this journey been quoted before?" (the short name avoids PostgreSQL's
-- 63-byte identifier limit, which would otherwise truncate it).
CREATE INDEX IF NOT EXISTS fare_quotes_endpoints_idx
  ON fare_quotes (origin_service_point_id, destination_service_point_id);

-- ---------------------------------------------------------------------------
-- 5. fare_quotes: immutable
--
-- A quote records a price that was offered to someone at a moment in time. If it
-- could be edited afterwards it would stop being evidence, so an UPDATE is
-- refused outright -- there is no column worth changing and no code path that
-- tries to.
--
-- DELETE is intentionally *not* blocked: nothing in the application deletes a
-- quote, and this phase adds no delete path, but a future retention or
-- subject-erasure job would need to, and expiration in particular never does.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_fare_quote_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fare quote % is immutable', OLD.id USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fare_quotes_immutable ON fare_quotes;
CREATE TRIGGER fare_quotes_immutable
  BEFORE UPDATE ON fare_quotes
  FOR EACH ROW EXECUTE FUNCTION prevent_fare_quote_change();

COMMENT ON TABLE fare_policies IS
  'Versioned solo-fare pricing policies. Immutable once quoted; add a version instead.';
COMMENT ON TABLE fare_quotes IS
  'Immutable, expiring fare quotes. One row per quoted price, with its policy version and route snapshot.';
COMMENT ON COLUMN fare_quotes.route_snapshot IS
  'Ordered per-edge audit trail: codes, distances, durations, fare weights and their distance charges.';
COMMENT ON COLUMN fare_quotes.fare_breakdown IS
  'Component-by-component breakdown of the fare, with the rounding rule that produced it.';
