-- Pool-first shared matching: proposing that a waiting passenger joins a pool
-- that is already forming, instead of only ever starting a new one.
--
-- WHAT THIS FILE ADDS
--
--   1. `dispatch_offers.pool_version` - the pool version an ADD_PASSENGER offer
--      was planned against, which is what makes a stale proposal detectable.
--   2. A CHECK: an ADD_PASSENGER offer must name a pool and that pool version.
--   3. `one_pending_route_change_offer_per_pool` - a pool can be considering one
--      join at a time.
--   4. `one_pending_offer_per_driver` - a driver holds one offer at a time,
--      whichever kind it is. This *supersedes* the initial-ride-only index from
--      09, which is dropped below: a driver has one attention span, not one per
--      offer type.
--   5. A GiST index on `ride_pools.planned_route_geometry`, so "which forming
--      pools pass near this pickup?" is an index scan rather than a scan of every
--      pool.
--   6. The new request events (`POOL_JOIN_*`, the candidate evaluation and the
--      fallback) and pool events (`JOIN_PLAN_CREATED`, `ROUTE_PLAN_UPDATED`).
--   7. The offer immutability trigger, updated so an ADD_PASSENGER offer may
--      name its pool *when it is created* rather than only when it is accepted.
--
-- WHAT THIS FILE DOES NOT DO
--
-- No shared fare, no pooling discount and no fare redistribution: every passenger
-- keeps the solo fare their own quote accepted. No trip operations either -- only
-- FORMING pools are matched into, so a pool that has started is never changed.

-- ---------------------------------------------------------------------------
-- 1. dispatch_offers: the pool a join offer was planned against
--
-- Nullable because an INITIAL_RIDE offer has no pool until it is accepted. The
-- CHECK below makes it mandatory for an ADD_PASSENGER offer, which is the only
-- kind that proposes a change to a pool that already exists.
-- ---------------------------------------------------------------------------
ALTER TABLE dispatch_offers
  ADD COLUMN IF NOT EXISTS pool_version INTEGER;

ALTER TABLE dispatch_offers
  DROP CONSTRAINT IF EXISTS dispatch_offers_add_passenger_has_pool;
ALTER TABLE dispatch_offers
  ADD CONSTRAINT dispatch_offers_add_passenger_has_pool CHECK (
    offer_type <> 'ADD_PASSENGER'
    OR (ride_pool_id IS NOT NULL AND pool_version IS NOT NULL AND pool_version > 0)
  );

-- The stale-plan guard. A proposal is only meaningful against the version of the
-- pool it was planned from, so the version has to be recorded with it.
COMMENT ON COLUMN dispatch_offers.pool_version IS
  'The ride_pools.version this ADD_PASSENGER proposal was planned against. Acceptance refuses an offer whose version is no longer current.';

-- ---------------------------------------------------------------------------
-- 2. One pending join offer per pool, and one pending offer per driver
-- ---------------------------------------------------------------------------
-- A pool may have exactly one proposed route change outstanding: two passengers
-- cannot both be joining the same pool, because the second plan would be built
-- against a stop order the first one is about to change.
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_route_change_offer_per_pool
  ON dispatch_offers (ride_pool_id)
  WHERE status = 'PENDING' AND offer_type = 'ADD_PASSENGER';

-- A driver, whichever kind of offer they are looking at, has one thing to answer.
-- This generalises `one_pending_initial_offer_per_driver` from 09, which is
-- dropped here rather than left as a second, narrower rule saying the same thing.
DROP INDEX IF EXISTS one_pending_initial_offer_per_driver;
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_offer_per_driver
  ON dispatch_offers (driver_profile_id)
  WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------
-- 3. The spatial index the candidate prefilter needs
--
-- `planned_route_geometry` was added by 09 without an index, because nothing
-- searched it. Matching a new pickup against a pool's planned route does, so the
-- GiST index it needs arrives with the query that uses it.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ride_pools_planned_route_geometry_idx
  ON ride_pools USING GIST (planned_route_geometry);

-- The candidate query's non-spatial access path: forming pools with room left.
CREATE INDEX IF NOT EXISTS ride_pools_forming_idx
  ON ride_pools (status, created_at)
  WHERE status = 'FORMING';

-- ---------------------------------------------------------------------------
-- 4. The offer update trigger, extended for join offers
--
-- The rule from 09 was "ride_pool_id may only be set when the offer becomes
-- ACCEPTED". An ADD_PASSENGER offer names its pool at creation instead, because
-- the pool *is* the proposal -- so the trigger now allows that one case and still
-- refuses everything else, including moving an offer to a different pool.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_dispatch_offer_update() RETURNS trigger AS $$
DECLARE
  status_allowed boolean;
BEGIN
  IF (NEW.ride_request_id, NEW.driver_profile_id, NEW.vehicle_id, NEW.offer_type,
      NEW.approach_distance_meters, NEW.approach_duration_seconds, NEW.score,
      NEW.offered_at, NEW.expires_at, NEW.proposal_snapshot, NEW.pool_version)
     IS DISTINCT FROM
     (OLD.ride_request_id, OLD.driver_profile_id, OLD.vehicle_id, OLD.offer_type,
      OLD.approach_distance_meters, OLD.approach_duration_seconds, OLD.score,
      OLD.offered_at, OLD.expires_at, OLD.proposal_snapshot, OLD.pool_version)
  THEN
    RAISE EXCEPTION
      'dispatch offer % is immutable: its driver, request, vehicle, approach, score, proposal and pool version cannot change',
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

  -- A pool reference may be set once, and may only be *cleared* by the foreign
  -- key's ON DELETE SET NULL when that pool is removed.
  IF OLD.ride_pool_id IS NOT NULL AND NEW.ride_pool_id IS NOT NULL
     AND NEW.ride_pool_id IS DISTINCT FROM OLD.ride_pool_id
  THEN
    RAISE EXCEPTION 'dispatch offer % cannot be moved to another pool', OLD.id
      USING ERRCODE = '23514';
  END IF;

  -- An initial offer points at the pool its acceptance created, so it may only
  -- name one once it is accepted. A join offer points at an existing pool from
  -- the moment it is created, because that pool is what it proposes changing.
  IF NEW.ride_pool_id IS NOT NULL
     AND NEW.status <> 'ACCEPTED'
     AND NEW.offer_type <> 'ADD_PASSENGER'
  THEN
    RAISE EXCEPTION 'dispatch offer % can only belong to a pool once it is accepted', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 5. Events
--
-- The request's timeline gains the pool-join steps and the fallback, so "what
-- happened to this passenger's request" stays one ordered list whether they
-- joined an existing pool or started a new one.
-- ---------------------------------------------------------------------------
ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'POOL_CANDIDATE_EVALUATED';
ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'POOL_JOIN_OFFERED';
ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'POOL_JOIN_REJECTED';
ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'POOL_JOIN_ACCEPTED';
ALTER TYPE ride_event_type ADD VALUE IF NOT EXISTS 'INITIAL_DISPATCH_FALLBACK';

-- The pool's timeline gains the plan that was proposed and the plan that was
-- adopted. `MEMBER_ADDED` and `ROUTE_PLAN_CREATED` already exist from 09.
ALTER TYPE pool_event_type ADD VALUE IF NOT EXISTS 'JOIN_PLAN_CREATED';
ALTER TYPE pool_event_type ADD VALUE IF NOT EXISTS 'ROUTE_PLAN_UPDATED';

COMMENT ON INDEX one_pending_route_change_offer_per_pool IS
  'A pool may be considering one proposed route change at a time.';
COMMENT ON INDEX one_pending_offer_per_driver IS
  'A driver holds one pending offer, of any kind: one thing to answer at a time.';
COMMENT ON COLUMN ride_pools.version IS
  'Incremented by every accepted route-plan change. An ADD_PASSENGER offer planned against an older version cannot be accepted.';
