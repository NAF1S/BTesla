-- The driver-operated trip: leaving for the first pickup, arriving at each stop,
-- collecting and delivering passengers, and completing the pool.
--
-- WHAT THIS FILE ADDS
--
--   1. `ride_pools.departed_at` -- when the driver set off. The pool already had
--      `driver_arrived_at`, `started_at`, `completed_at` and `cancelled_at`; this
--      is the missing first step, and with it every pool status now has the
--      instant that justifies it.
--   2. `pool_stops.completed_at` -- when the action at a stop finished. A stop
--      already recorded when the driver reached it (`actual_arrival_at`); the
--      pair is what makes "ARRIVED then COMPLETED" a fact rather than a claim.
--   3. `ride_requests.started_at` and `ride_requests.completed_at` -- the
--      passenger's own ride, as distinct from the pool's. A request already had
--      `requested_at` and `cancelled_at`; these are the two ends of the journey
--      it was matched for, and they are what a passenger's ride history is made
--      of.
--   4. Four lifecycle CHECKs, one per table, saying that a status and the
--      timestamps that belong to it cannot disagree. They are the same idea as
--      `ride_pools_lifecycle_consistent` from 09, extended to the states the trip
--      introduces.
--   5. The pool and request event values the trip writes.
--
-- WHAT THIS FILE DOES NOT DO
--
-- No payment, no settlement, no cancellation by either side, no no-show, no GPS,
-- no notifications, no rating, and no rematching after departure. `CANCELLED` and
-- `NO_SHOW` on a member, `SKIPPED` on a stop, `CANCELLED` on a pool and
-- `MATCHED -> CANCELLED` on a request all stay defined and unused, exactly as the
-- earlier milestones left them.
--
-- NAMING
--
-- The product's pool states are FORMING -> DRIVER_EN_ROUTE -> ARRIVED ->
-- IN_PROGRESS -> COMPLETED (09-driver-dispatch.sql). "ARRIVED" is the state a
-- brief for this milestone may call DRIVER_ARRIVED: the driver has reached the
-- stop. One concept, one enum value -- adding a second label for it would mean
-- two names for one state and a migration to reconcile them later.

-- ---------------------------------------------------------------------------
-- 1. ride_pools: the departure instant, and a lifecycle that closes
--
-- The rules, in one place:
--
--   FORMING                    no departure, no arrival, no start, no end
--   DRIVER_EN_ROUTE            departed
--   ARRIVED                    departed, and the driver is at the first pickup
--   IN_PROGRESS                departed and started
--   COMPLETED                  departed, started and completed
--   CANCELLED                  a cancellation time (no trip was driven)
--
-- `driver_arrived_at` is the moment the pool reached its first pickup stop, not
-- the moment of every later arrival: the later ones are stop facts, and they live
-- on `pool_stops.actual_arrival_at` where they belong.
-- ---------------------------------------------------------------------------
ALTER TABLE ride_pools
  ADD COLUMN IF NOT EXISTS departed_at TIMESTAMPTZ;

COMMENT ON COLUMN ride_pools.departed_at IS
  'When the driver set off for the first pickup. Set once, with the move out of FORMING.';

ALTER TABLE ride_pools
  DROP CONSTRAINT IF EXISTS ride_pools_lifecycle_consistent;
ALTER TABLE ride_pools
  ADD CONSTRAINT ride_pools_lifecycle_consistent CHECK (
    -- The statuses that mean "the driver is under way" all need a departure.
    (status = 'FORMING' OR departed_at IS NOT NULL)
    -- A completed pool has finished, and a cancelled one was never driven.
    AND (status <> 'COMPLETED' OR completed_at IS NOT NULL)
    AND (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
    -- Started means a start instant, and only IN_PROGRESS has one.
    AND (status <> 'IN_PROGRESS' OR started_at IS NOT NULL)
    AND (status IN ('IN_PROGRESS', 'COMPLETED') OR started_at IS NULL)
    -- Arrived means the driver is at (or has been to) the first pickup.
    AND (status <> 'ARRIVED' OR driver_arrived_at IS NOT NULL)
    AND (status NOT IN ('FORMING', 'DRIVER_EN_ROUTE') OR driver_arrived_at IS NULL)
    -- Only a finished trip has a completion instant.
    AND (status IN ('COMPLETED', 'CANCELLED') OR completed_at IS NULL)
    -- Nothing before the departure may claim a departure instant.
    AND (status <> 'FORMING' OR (driver_arrived_at IS NULL AND started_at IS NULL AND completed_at IS NULL))
  );

-- ---------------------------------------------------------------------------
-- 2. pool_stops: when the action finished
--
-- A stop is reached (`ARRIVED`) and then finished (`COMPLETED`). Both instants
-- are recorded, and the CHECK below is what stops a stop being finished without
-- ever having been reached -- which is the database's version of "a driver cannot
-- pick a passenger up at a stop they have not arrived at".
--
-- `SKIPPED` is the reserved status from 09 and is left unconstrained, because
-- nothing writes it: a skipped stop is a product decision (the passenger never
-- showed up, or the driver could not get there) that this milestone does not
-- take.
-- ---------------------------------------------------------------------------
ALTER TABLE pool_stops
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

COMMENT ON COLUMN pool_stops.completed_at IS
  'When the last required action at this stop finished. Set once, by the pickup or drop-off that completed it.';

ALTER TABLE pool_stops
  DROP CONSTRAINT IF EXISTS pool_stops_lifecycle_consistent;
ALTER TABLE pool_stops
  ADD CONSTRAINT pool_stops_lifecycle_consistent CHECK (
    (status <> 'ARRIVED' OR actual_arrival_at IS NOT NULL)
    AND (status <> 'COMPLETED' OR (actual_arrival_at IS NOT NULL AND completed_at IS NOT NULL))
    AND (status <> 'PENDING' OR (actual_arrival_at IS NULL AND completed_at IS NULL))
    AND (status = 'COMPLETED' OR completed_at IS NULL)
  );

-- ---------------------------------------------------------------------------
-- 3. pool_members: the passenger's own two instants
--
-- `ASSIGNED -> PICKED_UP -> DROPPED_OFF`, with the times that say so. The
-- CANCELLED and NO_SHOW states from 09 stay defined and unused -- a passenger who
-- never appears is a product decision with money attached, and this milestone
-- only drives the passengers who are in the car.
-- ---------------------------------------------------------------------------
ALTER TABLE pool_members
  DROP CONSTRAINT IF EXISTS pool_members_lifecycle_consistent;
ALTER TABLE pool_members
  ADD CONSTRAINT pool_members_lifecycle_consistent CHECK (
    (status <> 'PICKED_UP' OR (picked_up_at IS NOT NULL AND dropped_off_at IS NULL))
    AND (status <> 'DROPPED_OFF' OR (picked_up_at IS NOT NULL AND dropped_off_at IS NOT NULL))
    AND (status NOT IN ('ASSIGNED', 'CANCELLED', 'NO_SHOW') OR (picked_up_at IS NULL AND dropped_off_at IS NULL))
    AND (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 4. ride_requests: the passenger's ride, as opposed to the pool's trip
--
-- A request is the passenger's own record. It is MATCHED when a driver is
-- assigned, IN_PROGRESS while they are in the car, and COMPLETED when they have
-- been delivered -- which can happen while the pool is still carrying somebody
-- else, so these two instants are the only place a passenger's completed ride is
-- visible before the pool itself is finished.
--
-- The transition trigger from 08 already allows MATCHED -> IN_PROGRESS and
-- IN_PROGRESS -> COMPLETED; this milestone is what finally performs them, and
-- these columns are what it performs them with.
-- ---------------------------------------------------------------------------
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

COMMENT ON COLUMN ride_requests.started_at IS
  'When this passenger''s ride began: the driver started the trip with them on board.';
COMMENT ON COLUMN ride_requests.completed_at IS
  'When this passenger was delivered. Set once, and independent of when the pool itself completes.';

ALTER TABLE ride_requests
  DROP CONSTRAINT IF EXISTS ride_requests_lifecycle_consistent;
ALTER TABLE ride_requests
  ADD CONSTRAINT ride_requests_lifecycle_consistent CHECK (
    -- Only a ride that is under way or finished has a start, and any ride that
    -- is under way or finished has one.
    (status IN ('IN_PROGRESS', 'COMPLETED') OR started_at IS NULL)
    AND (status NOT IN ('IN_PROGRESS', 'COMPLETED') OR started_at IS NOT NULL)
    -- Only a completed ride has a completion instant, and every completed ride
    -- has one.
    AND (status = 'COMPLETED' OR completed_at IS NULL)
    AND (status <> 'COMPLETED' OR completed_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 5. Events
--
-- The pool's timeline gains the driver's trip: setting off, reaching a stop,
-- starting the journey, finishing it, and releasing the driver. The request's
-- timeline gains the one event a passenger cares about before they are collected:
-- that the driver is at their pickup.
--
-- The values the trip already had in the vocabulary are reused rather than
-- duplicated under new names:
--
--   MEMBER_PICKED_UP / MEMBER_DROPPED_OFF   the passenger actions at the pool
--   PASSENGER_PICKED_UP / PASSENGER_DROPPED_OFF   the same facts on the request
--   RIDE_STARTED                            the passenger's ride beginning
--   RIDE_COMPLETED                          the passenger's ride ending
--   DRIVER_OFFER_CANCELLED                  a join offer that a departure ended
--
-- `POOL_STATUS_CHANGED` and `POOL_CANCELLED` stay reserved: each transition this
-- milestone performs has its own event, and a second row saying "the status
-- changed" would be a duplicate of a fact already recorded.
-- ---------------------------------------------------------------------------
ALTER TYPE pool_event_type ADD VALUE IF NOT EXISTS 'DRIVER_DEPARTED';
ALTER TYPE pool_event_type ADD VALUE IF NOT EXISTS 'STOP_ARRIVED';
ALTER TYPE pool_event_type ADD VALUE IF NOT EXISTS 'TRIP_STARTED';
ALTER TYPE pool_event_type ADD VALUE IF NOT EXISTS 'TRIP_COMPLETED';
ALTER TYPE pool_event_type ADD VALUE IF NOT EXISTS 'DRIVER_AVAILABLE';

ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'DRIVER_ARRIVED';

-- ---------------------------------------------------------------------------
-- 6. The read paths the trip adds
--
-- The driver's next actionable stop is "the lowest sequence whose status is not
-- COMPLETED", which `pool_stops_pool_sequence_unique` already serves. The one
-- access path worth adding is the passenger's own completed rides, which their
-- history page reads by status and completion instant.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ride_requests_passenger_completed_at_idx
  ON ride_requests (passenger_profile_id, completed_at DESC)
  WHERE completed_at IS NOT NULL;

COMMENT ON TABLE pool_stops IS
  'The ordered plan for a pool: one PICKUP and one DROPOFF per member. Reached (actual_arrival_at) then finished (completed_at), in sequence order.';
COMMENT ON COLUMN ride_pools.status IS
  'FORMING -> DRIVER_EN_ROUTE -> ARRIVED -> IN_PROGRESS -> COMPLETED. ARRIVED is "the driver is at the first pickup stop". A pool that is no longer FORMING is closed to matching.';
COMMENT ON COLUMN pool_stops.status IS
  'PENDING -> ARRIVED -> COMPLETED. SKIPPED is reserved: nothing writes it.';
