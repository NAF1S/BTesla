-- ---------------------------------------------------------------------------
-- Ride requests: passenger-owned quotes, the request lifecycle and its history.
--
--   fare_quotes.passenger_profile_id -> who a quote belongs to
--   ride_requests                    -> one passenger, one journey, one status
--   ride_events                      -> append-only history of that lifecycle
--
-- ---------------------------------------------------------------------------
-- ONE REQUEST IS ONE PASSENGER, ONE JOURNEY
-- ---------------------------------------------------------------------------
-- There is no seat count anywhere in this schema, on purpose. A ride request
-- represents one passenger travelling from one pickup point to one destination
-- point, and the fare it accepts is that passenger's fare. Future capacity
-- planning counts *assigned passenger requests*, not seats, so no column here
-- has to be migrated away when pooling arrives.
--
-- ---------------------------------------------------------------------------
-- WHAT THE DATABASE ENFORCES, AND WHY IT IS NOT LEFT TO THE SERVICE
-- ---------------------------------------------------------------------------
-- Three of the rules in this milestone are correctness rules under concurrency,
-- so each is a database constraint rather than a check a service performs:
--
--   * one active request per passenger
--         -> partial unique index `one_active_ride_request_per_passenger`
--   * one request per accepted quote
--         -> UNIQUE (fare_quote_id)
--   * one request per (passenger, idempotency key)
--         -> UNIQUE (passenger_profile_id, idempotency_key)
--
-- Two more are history rules, and are enforced by triggers: a request's identity
-- and accepted money are written once and never change, and its status may only
-- move along the transitions the product defines. A service that forgot to check
-- would be refused by the database, which is the point.
--
-- Money is `numeric`, as everywhere else: `accepted_fare` is a copy of the
-- quote's exact decimal fare, never a float and never recomputed later.
--
-- Idempotent: this file is re-applied by `npm run db:migrate`.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. FareQuote ownership
--
-- Nullable on purpose. Quotes created before this milestone have no owner, and
-- "has no owner" must stay distinguishable from "belongs to this passenger":
-- a legacy quote can never be claimed, and a request can never be created from
-- one. The migration backfills nothing, so nothing is silently claimed.
--
-- ON DELETE CASCADE: a quote is a passenger's own calculation, and it is
-- meaningless without them. (A request that accepted a quote is protected from
-- the other direction -- see `ride_requests.fare_quote_id` below.)
-- ---------------------------------------------------------------------------
ALTER TABLE fare_quotes ADD COLUMN IF NOT EXISTS passenger_profile_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fare_quotes_passenger_profile_id_fkey'
  ) THEN
    ALTER TABLE fare_quotes
      ADD CONSTRAINT fare_quotes_passenger_profile_id_fkey
      FOREIGN KEY (passenger_profile_id) REFERENCES passenger_profiles (id)
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fare_quotes_passenger_profile_id_idx
  ON fare_quotes (passenger_profile_id);

COMMENT ON COLUMN fare_quotes.passenger_profile_id IS
  'The passenger this quote was calculated for, from authentication. NULL means an unowned legacy quote, which can never be claimed or accepted.';

-- ---------------------------------------------------------------------------
-- 2. Enums
-- PostgreSQL has no CREATE TYPE IF NOT EXISTS, so these are guarded by catalog,
-- the way 04-auth.sql and 07-fare-pricing.sql do it. Prisma maps them onto the
-- RideRequestStatus, RideEventType, RideActorType and CancellationReason enums
-- in server/prisma/schema.prisma.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- The full passenger-visible lifecycle. MATCHED, IN_PROGRESS and COMPLETED
  -- exist now so that no later milestone has to alter an enum in use; only the
  -- WAITING transitions are implemented in this phase.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ride_request_status') THEN
    CREATE TYPE ride_request_status AS ENUM (
      'WAITING', 'MATCHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED'
    );
  END IF;

  -- The three an operation in this phase writes, plus the five reserved for the
  -- matching and trip milestones.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ride_event_type') THEN
    CREATE TYPE ride_event_type AS ENUM (
      'RIDE_REQUESTED', 'RIDE_CANCELLED', 'RIDE_EXPIRED',
      'PASSENGER_MATCHED', 'RIDE_STARTED', 'RIDE_COMPLETED',
      'PASSENGER_PICKED_UP', 'PASSENGER_DROPPED_OFF'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ride_actor_type') THEN
    CREATE TYPE ride_actor_type AS ENUM ('PASSENGER', 'SYSTEM', 'ADMIN');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ride_cancellation_reason') THEN
    CREATE TYPE ride_cancellation_reason AS ENUM (
      'CHANGED_MIND', 'WRONG_LOCATION', 'WAIT_TOO_LONG', 'OTHER'
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. ride_requests
--
-- The accepted_* columns are copies of the quote, not references to it: a later
-- FarePolicy version, or a superseded rate, must never change what a passenger
-- already agreed to. They are also immutable once written (trigger below).
--
-- `requested_at` and `search_expires_at` come from the application clock and are
-- stored as instants; `created_at` is the database's own record of the insert.
-- The search window is checked to be non-empty, so a request can never be born
-- already expired.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_requests (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_profile_id     UUID NOT NULL REFERENCES passenger_profiles (id) ON DELETE CASCADE,
  -- UNIQUE: a quote is accepted at most once. This is what stops two concurrent
  -- requests from both consuming the same quote.
  fare_quote_id            UUID NOT NULL UNIQUE REFERENCES fare_quotes (id) ON DELETE RESTRICT,
  pickup_service_point_id  UUID NOT NULL REFERENCES service_points (id) ON DELETE RESTRICT,
  dropoff_service_point_id UUID NOT NULL REFERENCES service_points (id) ON DELETE RESTRICT,
  status                   ride_request_status NOT NULL DEFAULT 'WAITING',
  requested_at             TIMESTAMPTZ NOT NULL,
  search_expires_at        TIMESTAMPTZ NOT NULL,
  cancelled_at             TIMESTAMPTZ,
  cancellation_reason      ride_cancellation_reason,
  idempotency_key          TEXT NOT NULL,
  request_fingerprint      TEXT NOT NULL,
  accepted_fare            NUMERIC(14, 6) NOT NULL,
  currency                 TEXT NOT NULL,
  accepted_pricing_code    TEXT NOT NULL,
  accepted_pricing_version INTEGER NOT NULL,
  accepted_distance_meters INTEGER NOT NULL,
  accepted_duration_seconds INTEGER NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ride_requests_passenger_idempotency_key_unique
    UNIQUE (passenger_profile_id, idempotency_key),
  CONSTRAINT ride_requests_search_window_valid CHECK (search_expires_at > requested_at),
  CONSTRAINT ride_requests_endpoints_differ
    CHECK (pickup_service_point_id <> dropoff_service_point_id),
  -- Cancelled means cancelled: a terminal cancellation has a time, a reason and
  -- nothing else in those columns, and no other status may carry them.
  CONSTRAINT ride_requests_cancellation_consistent CHECK (
    CASE
      WHEN status = 'CANCELLED' THEN cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL
      ELSE cancelled_at IS NULL AND cancellation_reason IS NULL
    END
  ),
  -- Idempotency keys are opaque client tokens, but they are stored and compared,
  -- so their shape is pinned here as well as in the application.
  CONSTRAINT ride_requests_idempotency_key_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  -- A fingerprint is always a SHA-256 digest in lower-case hex; the application
  -- computes it and can never accept one from a client.
  CONSTRAINT ride_requests_fingerprint_format
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ride_requests_accepted_amounts CHECK (
    accepted_fare >= 0
    AND accepted_distance_meters > 0
    AND accepted_duration_seconds > 0
    AND accepted_pricing_version > 0
  ),
  CONSTRAINT ride_requests_currency_format CHECK (currency ~ '^[A-Z]{3}$')
);

-- A passenger may have exactly one request in flight. WAITING, MATCHED and
-- IN_PROGRESS all count as active, which is why matching and trip milestones
-- will not need a new index -- they inherit this rule.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_ride_request_per_passenger
  ON ride_requests (passenger_profile_id)
  WHERE status IN ('WAITING', 'MATCHED', 'IN_PROGRESS');

-- "My requests", newest first: the shape of the passenger history endpoint.
CREATE INDEX IF NOT EXISTS ride_requests_passenger_requested_at_idx
  ON ride_requests (passenger_profile_id, requested_at DESC);

-- The expiration sweep's access path.
CREATE INDEX IF NOT EXISTS ride_requests_status_search_expires_at_idx
  ON ride_requests (status, search_expires_at);

DROP TRIGGER IF EXISTS ride_requests_set_updated_at ON ride_requests;
CREATE TRIGGER ride_requests_set_updated_at
  BEFORE UPDATE ON ride_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. ride_requests: what may change after the insert
--
-- Two rules, both history rules:
--
--   1. Identity and accepted money are write-once. A request is evidence of what
--      a passenger agreed to, so its passenger, quote, endpoints, timing,
--      idempotency key and accepted fare may never be edited -- by a service, a
--      bug, or a migration that ran in the wrong order.
--
--   2. Status moves only along the product's transitions:
--
--        WAITING     -> MATCHED | CANCELLED | EXPIRED
--        MATCHED     -> IN_PROGRESS | CANCELLED
--        IN_PROGRESS -> COMPLETED
--        COMPLETED   -> (terminal)
--        CANCELLED   -> (terminal)
--        EXPIRED     -> (terminal)
--
--      MATCHED and IN_PROGRESS transitions are *allowed here but not implemented
--      in this milestone*: they are reserved so matching can be added without a
--      migration, and nothing in the API can reach them yet.
--
-- `cancelled_at`, `cancellation_reason` and `status` are written by the
-- transition service, in one transaction with the event that records them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_ride_request_update() RETURNS trigger AS $$
DECLARE
  transition_allowed boolean;
BEGIN
  IF (NEW.passenger_profile_id, NEW.fare_quote_id, NEW.pickup_service_point_id,
      NEW.dropoff_service_point_id, NEW.requested_at, NEW.idempotency_key,
      NEW.request_fingerprint, NEW.accepted_fare, NEW.currency,
      NEW.accepted_pricing_code, NEW.accepted_pricing_version,
      NEW.accepted_distance_meters, NEW.accepted_duration_seconds)
     IS DISTINCT FROM
     (OLD.passenger_profile_id, OLD.fare_quote_id, OLD.pickup_service_point_id,
      OLD.dropoff_service_point_id, OLD.requested_at, OLD.idempotency_key,
      OLD.request_fingerprint, OLD.accepted_fare, OLD.currency,
      OLD.accepted_pricing_code, OLD.accepted_pricing_version,
      OLD.accepted_distance_meters, OLD.accepted_duration_seconds)
  THEN
    RAISE EXCEPTION
      'ride request % is immutable: its passenger, quote, endpoints, key and accepted fare cannot change',
      OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    transition_allowed := CASE OLD.status
      WHEN 'WAITING'     THEN NEW.status IN ('MATCHED', 'CANCELLED', 'EXPIRED')
      WHEN 'MATCHED'     THEN NEW.status IN ('IN_PROGRESS', 'CANCELLED')
      WHEN 'IN_PROGRESS' THEN NEW.status IN ('COMPLETED')
      ELSE false
    END;

    IF NOT transition_allowed THEN
      RAISE EXCEPTION 'illegal ride request transition % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ride_requests_enforce_update ON ride_requests;
CREATE TRIGGER ride_requests_enforce_update
  BEFORE UPDATE ON ride_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_ride_request_update();

-- ---------------------------------------------------------------------------
-- 5. ride_events
--
-- Append-only history. One row per thing that happened, in order, with the
-- status it moved from and to. Sequence numbers are per request and unique, so
-- "the order it happened in" is a fact rather than a convention, and a
-- pessimistic lock on the request is what keeps two concurrent writers from
-- picking the same number.
--
-- ON DELETE CASCADE, matching the project's rule for data that is meaningless
-- without its parent (profiles and vehicles behave the same way): an event about
-- a request that no longer exists explains nothing. Nothing in the application
-- deletes either.
--
-- `metadata` is audit-safe by rule: it records what happened, never who the
-- passenger is. No tokens, no contact details, no free text from a client.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_request_id UUID NOT NULL REFERENCES ride_requests (id) ON DELETE CASCADE,
  sequence        INTEGER NOT NULL,
  event_type      ride_event_type NOT NULL,
  actor_type      ride_actor_type NOT NULL,
  -- Nullable: a SYSTEM event has no user behind it, and an actor whose account
  -- is later deleted leaves the event intact rather than erasing history.
  actor_user_id   UUID REFERENCES users (id) ON DELETE SET NULL,
  previous_status ride_request_status,
  new_status      ride_request_status NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ride_events_request_sequence_unique UNIQUE (ride_request_id, sequence),
  CONSTRAINT ride_events_sequence_positive CHECK (sequence > 0),
  -- An event payload is an object, so a client can never turn it into an array
  -- or a scalar through some future path.
  CONSTRAINT ride_events_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);

-- (ride_request_id, sequence) is already indexed by the unique constraint above,
-- which is also the access path for reading one request's history in order.

-- Immutability. UPDATE is refused outright: history that can be edited is not
-- history. DELETE is deliberately *not* blocked -- nothing in the application
-- deletes an event, and no endpoint exposes one, but cascading from a deleted
-- passenger account has to work, and a future retention or erasure job would
-- need it.
CREATE OR REPLACE FUNCTION prevent_ride_event_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ride event % is append-only', OLD.id USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ride_events_append_only ON ride_events;
CREATE TRIGGER ride_events_append_only
  BEFORE UPDATE ON ride_events
  FOR EACH ROW EXECUTE FUNCTION prevent_ride_event_change();

COMMENT ON TABLE ride_requests IS
  'One passenger, one journey, one quote. At most one active request per passenger; accepted fare is a frozen copy of the quote.';
COMMENT ON TABLE ride_events IS
  'Append-only lifecycle history. Ordered by (ride_request_id, sequence); UPDATE is refused by a trigger.';
COMMENT ON COLUMN ride_requests.request_fingerprint IS
  'SHA-256 of the canonical request inputs, computed server-side. Detects idempotency-key reuse with a different body. Never returned to a client.';
