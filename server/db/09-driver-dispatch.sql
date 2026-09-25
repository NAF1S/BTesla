-- Driver availability, sequential dispatch offers, and the single-passenger
-- RidePool a driver acceptance creates.
--
-- The whole milestone is here rather than spread across migrations because the
-- tables are only meaningful together: an offer exists to become a pool, and a
-- pool exists only because an offer was accepted.
--
-- WHAT THIS FILE ADDS
--
--   1. `driver_status` gains RESERVED, and `driver_profiles` gains the
--      availability state a dispatcher needs (current point, available since,
--      last seen, the vehicle the driver went online with).
--   2. `dispatch_offers` - one temporary, expiring offer to one driver.
--   3. `ride_pools` - one driver, one vehicle, one active pool at a time.
--   4. `pool_members` - one passenger, one request, at most one member row.
--   5. `pool_stops`  - the ordered pickup and drop-off of a member.
--   6. `pool_events` - append-only pool history, like ride_events.
--   7. `ride_event_type` gains the dispatch events, so an offer and a match are
--      recorded on the ride request's own timeline. `PASSENGER_MATCHED` already
--      exists from 08-ride-requests.sql and is *the* match event: it is reused
--      rather than duplicated under a second name.
--
-- WHY THE CONSTRAINTS ARE HERE AND NOT ONLY IN THE SERVICE
--
-- Every rule that two concurrent writers could break is a constraint below:
--
--   * at most one PENDING initial offer per request  (partial unique index)
--   * at most one PENDING initial offer per driver   (partial unique index)
--   * at most one active pool per driver             (partial unique index)
--   * at most one pool member per ride request       (UNIQUE)
--   * one stop per member per type, one stop per pool per sequence (UNIQUE)
--   * a rejected, accepted or expired offer is final (trigger)
--   * pool history is append-only                    (trigger)
--   * a stop's service point is the one the request named (trigger)
--
-- The service checks all of it too, for good error messages, but the database
-- is what decides a race.
--
-- NOTE ON THE ENUM ADDITIONS
--
-- `driver_status` gains RESERVED here. PostgreSQL 12+ allows ALTER TYPE ... ADD
-- VALUE inside a transaction block, but a value added in a transaction cannot be
-- *used* in that same transaction -- so nothing below tests a column against
-- 'RESERVED'. The driver_profiles CHECKs therefore mention 'AVAILABLE' only; the
-- RESERVED state is enforced by the state machine in the application, by
-- ride_pools.one_active_pool_per_driver, and by the tests.

-- ---------------------------------------------------------------------------
-- 1. Driver availability
--
-- `status` already existed (04-auth.sql) as OFFLINE | AVAILABLE | ON_RIDE. It
-- stays the single authoritative availability field: this migration extends it
-- with RESERVED rather than adding a second, competing status column.
--
--   OFFLINE   - not accepting offers
--   AVAILABLE - may receive an initial ride offer
--   RESERVED  - accepted a pool, trip has not started
--   ON_RIDE   - operating a trip (a later milestone)
-- ---------------------------------------------------------------------------
ALTER TYPE driver_status ADD VALUE IF NOT EXISTS 'RESERVED' AFTER 'AVAILABLE';

ALTER TABLE driver_profiles
  -- Nullable while offline: a driver who has never gone online has no point.
  ADD COLUMN IF NOT EXISTS current_service_point_id UUID REFERENCES service_points (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS available_since TIMESTAMPTZ,
  -- The last time the driver told us where they were (went online, moved, or
  -- read their offers). A stale value makes them ineligible for dispatch.
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  -- The vehicle this driver went online with. Recorded rather than guessed, so a
  -- driver with several vehicles is dispatched in the one they chose, and a
  -- vehicle that is deactivated later cannot be silently swapped in.
  ADD COLUMN IF NOT EXISTS active_vehicle_id UUID REFERENCES vehicles (id) ON DELETE SET NULL;

-- What "available" has to mean for the dispatcher: a driver cannot be available
-- without a point to be approached at, nor without having said when. Both are
-- written together with the state change, so a half-available driver cannot
-- exist. 'RESERVED' is deliberately not mentioned here -- see the note above.
ALTER TABLE driver_profiles
  DROP CONSTRAINT IF EXISTS driver_profiles_available_has_location;
ALTER TABLE driver_profiles
  ADD CONSTRAINT driver_profiles_available_has_location CHECK (
    status <> 'AVAILABLE'
    OR (current_service_point_id IS NOT NULL AND available_since IS NOT NULL)
  );

-- The dispatcher's access path: available drivers with a current point.
CREATE INDEX IF NOT EXISTS driver_profiles_dispatchable_idx
  ON driver_profiles (status, last_seen_at DESC)
  WHERE status = 'AVAILABLE';

CREATE INDEX IF NOT EXISTS driver_profiles_current_service_point_id_idx
  ON driver_profiles (current_service_point_id);

DROP TRIGGER IF EXISTS driver_profiles_set_updated_at ON driver_profiles;
CREATE TRIGGER driver_profiles_set_updated_at
  BEFORE UPDATE ON driver_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. ride_pools
--
-- Created *before* dispatch_offers because an offer points at the pool its
-- acceptance created.
--
-- Only FORMING is created in this milestone. The other statuses exist so the
-- trip milestones never have to alter an enum that is already in use, and the
-- partial unique index below already covers all of them -- a driver with a
-- forming, en-route, arrived or in-progress pool cannot take a second one.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ride_pool_status') THEN
    CREATE TYPE ride_pool_status AS ENUM (
      'FORMING', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ride_pools (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_profile_id       UUID NOT NULL REFERENCES driver_profiles (id) ON DELETE RESTRICT,
  vehicle_id              UUID NOT NULL REFERENCES vehicles (id) ON DELETE RESTRICT,
  status                  ride_pool_status NOT NULL DEFAULT 'FORMING',
  -- A copy of the vehicle's capacity at acceptance. A later capacity change must
  -- not rewrite the capacity a pool was planned with.
  capacity_snapshot       INTEGER NOT NULL,
  -- The passenger's route, from the accepted RideRequest's FareQuote snapshot.
  planned_route_geometry  GEOMETRY(LINESTRING, 4326),
  planned_distance_meters NUMERIC(12, 2) NOT NULL,
  planned_duration_seconds INTEGER NOT NULL,
  -- Bumped by future mutations (adding a passenger, re-planning). Present now so
  -- a later milestone can add optimistic concurrency without a migration.
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A pool exists only because an offer was accepted, so acceptance is its
  -- creation instant. Kept separate from created_at so a future queued creation
  -- can differ from the acceptance it belongs to.
  accepted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  driver_arrived_at       TIMESTAMPTZ,
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ride_pools_capacity_positive CHECK (capacity_snapshot > 0),
  CONSTRAINT ride_pools_route_valid CHECK (
    planned_distance_meters > 0 AND planned_duration_seconds > 0
  ),
  CONSTRAINT ride_pools_version_positive CHECK (version > 0),
  -- The timestamps a pool carries have to agree with its status: a pool cannot
  -- be COMPLETED without a completion time, or unfinished with a start time.
  CONSTRAINT ride_pools_lifecycle_consistent CHECK (
    (status <> 'COMPLETED' OR completed_at IS NOT NULL)
    AND (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
    AND (status NOT IN ('FORMING', 'DRIVER_EN_ROUTE', 'ARRIVED') OR started_at IS NULL)
  )
);

-- One active pool per driver. This is the index that makes "a driver cannot
-- accept two offers at once" a database answer rather than a service hope.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_pool_per_driver
  ON ride_pools (driver_profile_id)
  WHERE status IN ('FORMING', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS');

CREATE INDEX IF NOT EXISTS ride_pools_status_idx ON ride_pools (status);

DROP TRIGGER IF EXISTS ride_pools_set_updated_at ON ride_pools;
CREATE TRIGGER ride_pools_set_updated_at
  BEFORE UPDATE ON ride_pools
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. dispatch_offers
--
-- A temporary offer of one ride request to one driver, in one vehicle, that
-- expires. It is the only thing that can turn a WAITING request into a pool,
-- and it is written before the driver knows anything about it, so it has to be
-- cheap to create and safe to lose.
--
-- proposal_snapshot records what the driver was shown: the two service points,
-- the approach route summary, the passenger route summary, the vehicle and the
-- capacity. It deliberately holds no passenger identity, no contact details, no
-- money and no token -- the driver DTO is built from it, so whatever is not in
-- here cannot leak.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dispatch_offer_type') THEN
    CREATE TYPE dispatch_offer_type AS ENUM ('INITIAL_RIDE', 'ADD_PASSENGER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dispatch_offer_status') THEN
    CREATE TYPE dispatch_offer_status AS ENUM (
      'PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dispatch_rejection_reason') THEN
    CREATE TYPE dispatch_rejection_reason AS ENUM (
      'TOO_FAR', 'UNAVAILABLE', 'VEHICLE_ISSUE', 'OTHER'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dispatch_offers (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_request_id          UUID NOT NULL REFERENCES ride_requests (id) ON DELETE CASCADE,
  driver_profile_id        UUID NOT NULL REFERENCES driver_profiles (id) ON DELETE CASCADE,
  -- RESTRICT: an offer is evidence of which vehicle was proposed, so a vehicle
  -- that appears in dispatch history cannot be deleted out from under it.
  vehicle_id               UUID NOT NULL REFERENCES vehicles (id) ON DELETE RESTRICT,
  -- Set by acceptance, to the pool that acceptance created.
  ride_pool_id             UUID REFERENCES ride_pools (id) ON DELETE SET NULL,
  offer_type               dispatch_offer_type NOT NULL DEFAULT 'INITIAL_RIDE',
  status                   dispatch_offer_status NOT NULL DEFAULT 'PENDING',
  approach_distance_meters NUMERIC(12, 2) NOT NULL,
  approach_duration_seconds INTEGER NOT NULL,
  -- The deterministic candidate score the offer was chosen with. Stored so a
  -- dispatch decision can be explained after the fact.
  score                    NUMERIC(12, 2) NOT NULL,
  offered_at               TIMESTAMPTZ NOT NULL,
  expires_at               TIMESTAMPTZ NOT NULL,
  responded_at             TIMESTAMPTZ,
  rejection_reason         dispatch_rejection_reason,
  proposal_snapshot        JSONB NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_offers_window_valid CHECK (expires_at > offered_at),
  -- Zero is a real approach: a driver who is already at the pickup point. The
  -- distance is measured, and the duration is routed, so neither is ever a
  -- placeholder.
  CONSTRAINT dispatch_offers_approach_valid CHECK (
    approach_distance_meters >= 0 AND approach_duration_seconds >= 0
  ),
  CONSTRAINT dispatch_offers_score_valid CHECK (score >= 0),
  -- A response is recorded exactly when there was one, and a rejection always
  -- says why: refused rather than left half-written.
  CONSTRAINT dispatch_offers_response_consistent CHECK (
    CASE
      WHEN status = 'PENDING'  THEN responded_at IS NULL AND rejection_reason IS NULL
      WHEN status = 'REJECTED' THEN responded_at IS NOT NULL AND rejection_reason IS NOT NULL
      ELSE responded_at IS NOT NULL AND rejection_reason IS NULL
    END
  ),
  CONSTRAINT dispatch_offers_snapshot_is_object CHECK (jsonb_typeof(proposal_snapshot) = 'object')
);

-- Sequential dispatch, enforced: a request can be offered to one driver at a
-- time, so a second PENDING initial offer for the same request is impossible
-- even if two dispatchers run at once.
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_initial_offer_per_request
  ON dispatch_offers (ride_request_id)
  WHERE status = 'PENDING' AND offer_type = 'INITIAL_RIDE';

-- ...and a driver can be considering only one initial offer at a time, which is
-- what stops one driver accepting two different passengers' requests.
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_initial_offer_per_driver
  ON dispatch_offers (driver_profile_id)
  WHERE status = 'PENDING' AND offer_type = 'INITIAL_RIDE';

-- The dispatcher asks "does this driver already have a pending offer?" and the
-- expiry sweep asks "which offers are past their deadline?".
CREATE INDEX IF NOT EXISTS dispatch_offers_pending_expiry_idx
  ON dispatch_offers (expires_at)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS dispatch_offers_request_idx
  ON dispatch_offers (ride_request_id, offered_at DESC);

-- Who was offered what, and what did they say. Used for the "has this driver
-- already refused this request?" filter and for the fairness scoring.
CREATE INDEX IF NOT EXISTS dispatch_offers_driver_offered_at_idx
  ON dispatch_offers (driver_profile_id, offered_at DESC);

DROP TRIGGER IF EXISTS dispatch_offers_set_updated_at ON dispatch_offers;
CREATE TRIGGER dispatch_offers_set_updated_at
  BEFORE UPDATE ON dispatch_offers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The approach check was tightened to `> 0` in an earlier draft of this file;
-- a driver standing at the pickup point is a real candidate with a zero-second
-- approach, so the constraint is re-applied with `>= 0`. DROP then ADD rather
-- than ADD-if-missing, because the whole file must be safe to re-run.
ALTER TABLE dispatch_offers DROP CONSTRAINT IF EXISTS dispatch_offers_approach_valid;
ALTER TABLE dispatch_offers
  ADD CONSTRAINT dispatch_offers_approach_valid CHECK (
    approach_distance_meters >= 0 AND approach_duration_seconds >= 0
  );

-- What may change after an offer is written:
--
--   * everything that describes the offer itself is write-once -- the driver,
--     the request, the vehicle, the approach route, the score, the window and
--     the proposal the driver saw. An offer is evidence of what was proposed.
--   * the status moves PENDING -> one of the four terminal states, and a
--     terminal status is final. A rejected offer cannot be accepted later, and
--     an expired offer cannot be revived.
--   * ride_pool_id may be filled in once, when the offer becomes ACCEPTED.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_dispatch_offer_update() RETURNS trigger AS $$
DECLARE
  status_allowed boolean;
BEGIN
  IF (NEW.ride_request_id, NEW.driver_profile_id, NEW.vehicle_id, NEW.offer_type,
      NEW.approach_distance_meters, NEW.approach_duration_seconds, NEW.score,
      NEW.offered_at, NEW.expires_at, NEW.proposal_snapshot)
     IS DISTINCT FROM
     (OLD.ride_request_id, OLD.driver_profile_id, OLD.vehicle_id, OLD.offer_type,
      OLD.approach_distance_meters, OLD.approach_duration_seconds, OLD.score,
      OLD.offered_at, OLD.expires_at, OLD.proposal_snapshot)
  THEN
    RAISE EXCEPTION
      'dispatch offer % is immutable: its driver, request, vehicle, approach, score and proposal cannot change',
      OLD.id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    status_allowed := OLD.status = 'PENDING'
      AND NEW.status IN ('ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED');

    IF NOT status_allowed THEN
      RAISE EXCEPTION 'illegal dispatch offer transition % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.ride_pool_id IS NOT NULL AND NEW.ride_pool_id IS NOT NULL
     AND NEW.ride_pool_id IS DISTINCT FROM OLD.ride_pool_id
  THEN
    RAISE EXCEPTION 'dispatch offer % cannot be moved to another pool', OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- ride_pool_id may be *cleared* only by the foreign key's ON DELETE SET NULL,
  -- when the pool it points at is removed. That is a bookkeeping change, not a
  -- rewrite of what happened: the offer still records which driver accepted
  -- which request, and the pool's own history went with the pool.
  --
  -- It may not be set on anything but an accepted offer: a pool exists only
  -- because an offer was accepted, and this is what keeps that true.
  IF NEW.ride_pool_id IS NOT NULL AND NEW.status <> 'ACCEPTED' THEN
    RAISE EXCEPTION 'dispatch offer % can only belong to a pool once it is accepted', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dispatch_offers_enforce_update ON dispatch_offers;
CREATE TRIGGER dispatch_offers_enforce_update
  BEFORE UPDATE ON dispatch_offers
  FOR EACH ROW EXECUTE FUNCTION enforce_dispatch_offer_update();

-- ---------------------------------------------------------------------------
-- 4. pool_members
--
-- One row per passenger in a pool. `ride_request_id` is UNIQUE, which is the
-- database's answer to "can one request join two pools?": no. The member and the
-- request describe the same journey -- the member adds nothing a request does not
-- already hold, and deliberately copies no passenger contact data.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pool_member_status') THEN
    CREATE TYPE pool_member_status AS ENUM (
      'ASSIGNED', 'PICKED_UP', 'DROPPED_OFF', 'CANCELLED', 'NO_SHOW'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS pool_members (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_pool_id     UUID NOT NULL REFERENCES ride_pools (id) ON DELETE CASCADE,
  -- RESTRICT: a request that a pool was built around cannot be deleted.
  ride_request_id  UUID NOT NULL UNIQUE REFERENCES ride_requests (id) ON DELETE RESTRICT,
  status           pool_member_status NOT NULL DEFAULT 'ASSIGNED',
  matched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_up_at     TIMESTAMPTZ,
  dropped_off_at   TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pool_members_ride_pool_id_idx ON pool_members (ride_pool_id);

DROP TRIGGER IF EXISTS pool_members_set_updated_at ON pool_members;
CREATE TRIGGER pool_members_set_updated_at
  BEFORE UPDATE ON pool_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. pool_stops
--
-- The ordered plan for a pool. This milestone writes exactly two rows per
-- member: sequence 1 is the pickup, sequence 2 is the drop-off. Insertion,
-- reordering and skipping belong to later milestones, which is why the table
-- already carries a status and a planned arrival.
--
-- `sequence` is unique per pool so "the order it happens in" is a fact, and the
-- trigger below keeps a stop honest about which request and which place it
-- belongs to.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pool_stop_type') THEN
    CREATE TYPE pool_stop_type AS ENUM ('PICKUP', 'DROPOFF');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pool_stop_status') THEN
    CREATE TYPE pool_stop_status AS ENUM ('PENDING', 'ARRIVED', 'COMPLETED', 'SKIPPED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS pool_stops (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_pool_id       UUID NOT NULL REFERENCES ride_pools (id) ON DELETE CASCADE,
  ride_request_id    UUID NOT NULL REFERENCES ride_requests (id) ON DELETE RESTRICT,
  pool_member_id     UUID NOT NULL REFERENCES pool_members (id) ON DELETE CASCADE,
  service_point_id   UUID NOT NULL REFERENCES service_points (id) ON DELETE RESTRICT,
  stop_type          pool_stop_type NOT NULL,
  sequence           INTEGER NOT NULL,
  status             pool_stop_status NOT NULL DEFAULT 'PENDING',
  planned_arrival_at TIMESTAMPTZ NOT NULL,
  actual_arrival_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pool_stops_sequence_positive CHECK (sequence > 0),
  -- One stop per position in a pool's plan.
  CONSTRAINT pool_stops_pool_sequence_unique UNIQUE (ride_pool_id, sequence),
  -- One pickup and one drop-off per member: no duplicate stops for a passenger.
  CONSTRAINT pool_stops_member_type_unique UNIQUE (pool_member_id, stop_type)
);

-- The read path for one pool's plan, in order: `pool_stops_pool_sequence_unique`
-- below already indexes (ride_pool_id, sequence), so there is deliberately no
-- second index on the same columns.
CREATE INDEX IF NOT EXISTS pool_stops_ride_request_id_idx ON pool_stops (ride_request_id);

-- An earlier draft of this file created an index that duplicated the unique
-- constraint's own. Dropped here so an existing database converges on the same
-- schema as a fresh one -- the migration is re-run every time, so it has to be
-- self-correcting rather than additive.
DROP INDEX IF EXISTS pool_stops_ride_pool_id_idx;

DROP TRIGGER IF EXISTS pool_stops_set_updated_at ON pool_stops;
CREATE TRIGGER pool_stops_set_updated_at
  BEFORE UPDATE ON pool_stops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A stop has to agree with the request it serves and with its member, and the
-- pickup has to come before the drop-off. None of that is expressible as a
-- CHECK constraint, because it reads other rows -- so it is a trigger, the same
-- way 08-ride-requests.sql enforces what a CHECK cannot.
--
-- What this refuses:
--   * a PICKUP whose service point is not the request's pickup (and likewise
--     for a DROPOFF);
--   * a stop whose request and member disagree, or whose member belongs to
--     another pool;
--   * a drop-off placed before its pickup.
CREATE OR REPLACE FUNCTION enforce_pool_stop_consistency() RETURNS trigger AS $$
DECLARE
  request_pickup  UUID;
  request_dropoff UUID;
  member_pool     UUID;
  member_request  UUID;
  pickup_sequence INTEGER;
BEGIN
  SELECT pickup_service_point_id, dropoff_service_point_id
    INTO request_pickup, request_dropoff
    FROM ride_requests WHERE id = NEW.ride_request_id;

  IF request_pickup IS NULL THEN
    RAISE EXCEPTION 'pool stop % refers to a ride request that does not exist', NEW.id
      USING ERRCODE = '23503';
  END IF;

  SELECT ride_pool_id, ride_request_id
    INTO member_pool, member_request
    FROM pool_members WHERE id = NEW.pool_member_id;

  IF member_pool IS DISTINCT FROM NEW.ride_pool_id
     OR member_request IS DISTINCT FROM NEW.ride_request_id
  THEN
    RAISE EXCEPTION
      'pool stop % must belong to the member''s own pool and ride request', NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.stop_type = 'PICKUP' AND NEW.service_point_id <> request_pickup THEN
    RAISE EXCEPTION
      'pool stop % is a PICKUP but is not the request''s pickup service point', NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.stop_type = 'DROPOFF' AND NEW.service_point_id <> request_dropoff THEN
    RAISE EXCEPTION
      'pool stop % is a DROPOFF but is not the request''s destination service point', NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.stop_type = 'DROPOFF' THEN
    SELECT sequence INTO pickup_sequence
      FROM pool_stops
      WHERE pool_member_id = NEW.pool_member_id AND stop_type = 'PICKUP';

    IF pickup_sequence IS NULL OR pickup_sequence >= NEW.sequence THEN
      RAISE EXCEPTION 'pool stop % places a drop-off before its pickup', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pool_stops_enforce_consistency ON pool_stops;
CREATE TRIGGER pool_stops_enforce_consistency
  BEFORE INSERT OR UPDATE ON pool_stops
  FOR EACH ROW EXECUTE FUNCTION enforce_pool_stop_consistency();

-- ---------------------------------------------------------------------------
-- 6. pool_events
--
-- The pool's own append-only history, mirroring ride_events: one row per thing
-- that happened, numbered per pool, with the actor and a small JSON payload.
-- RideEvent keeps carrying the *request's* timeline (offered, rejected,
-- accepted, matched); this carries the pool's.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pool_event_type') THEN
    CREATE TYPE pool_event_type AS ENUM (
      'POOL_CREATED',
      'MEMBER_ADDED',
      'ROUTE_PLAN_CREATED',
      -- Reserved for the trip milestones; not written in this one.
      'MEMBER_PICKED_UP',
      'MEMBER_DROPPED_OFF',
      'POOL_STATUS_CHANGED',
      'POOL_CANCELLED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pool_actor_type') THEN
    CREATE TYPE pool_actor_type AS ENUM ('PASSENGER', 'DRIVER', 'SYSTEM', 'ADMIN');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS pool_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_pool_id  UUID NOT NULL REFERENCES ride_pools (id) ON DELETE CASCADE,
  sequence      INTEGER NOT NULL,
  event_type    pool_event_type NOT NULL,
  actor_type    pool_actor_type NOT NULL,
  -- Nullable like ride_events.actor_user_id: a SYSTEM event has no user behind
  -- it, and a deleted account leaves the history intact.
  actor_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pool_events_pool_sequence_unique UNIQUE (ride_pool_id, sequence),
  CONSTRAINT pool_events_sequence_positive CHECK (sequence > 0),
  CONSTRAINT pool_events_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);

-- (ride_pool_id, sequence) is already indexed by the unique constraint, which is
-- also the read path for one pool's history in order.

CREATE OR REPLACE FUNCTION prevent_pool_event_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pool event % is append-only', OLD.id USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pool_events_append_only ON pool_events;
CREATE TRIGGER pool_events_append_only
  BEFORE UPDATE ON pool_events
  FOR EACH ROW EXECUTE FUNCTION prevent_pool_event_change();

-- ---------------------------------------------------------------------------
-- 7. Ride events for dispatch
--
-- The offer and the match belong on the ride request's own timeline, next to
-- RIDE_REQUESTED, so "what happened to this passenger's request" is one ordered
-- list. PASSENGER_MATCHED already exists and is reused as the match event.
-- ---------------------------------------------------------------------------
ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'DRIVER_OFFERED';
ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'DRIVER_REJECTED';
ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'DRIVER_OFFER_EXPIRED';
ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'DRIVER_OFFER_CANCELLED';
ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'DRIVER_ACCEPTED';

COMMENT ON TABLE ride_pools IS
  'One driver, one vehicle, one active trip. Created only by an accepted dispatch offer; only FORMING is used in the dispatch milestone.';
COMMENT ON TABLE dispatch_offers IS
  'A temporary offer of one ride request to one driver. PENDING -> ACCEPTED/REJECTED/EXPIRED/CANCELLED, and final once terminal.';
COMMENT ON TABLE pool_members IS
  'One passenger per row. ride_request_id is UNIQUE: a ride request can join at most one pool.';
COMMENT ON TABLE pool_stops IS
  'The ordered plan for a pool: one PICKUP and one DROPOFF per member, each pinned to the service point the request named.';
COMMENT ON TABLE pool_events IS
  'Append-only pool history, ordered by (ride_pool_id, sequence). UPDATE is refused by a trigger.';
COMMENT ON COLUMN driver_profiles.active_vehicle_id IS
  'The vehicle the driver went online with; dispatch offers this vehicle and copies its capacity.';
COMMENT ON COLUMN dispatch_offers.proposal_snapshot IS
  'What the driver was shown: service points, approach and passenger route summaries, vehicle and capacity. Never passenger identity, contact details, money or tokens.';
COMMENT ON COLUMN ride_pools.capacity_snapshot IS
  'The accepted vehicle''s capacity at acceptance. A later change to the vehicle does not rewrite it.';
