-- ---------------------------------------------------------------------------
-- 13 — the read APIs' access paths
--
-- The passenger and driver history endpoints are the first reads in this project
-- that page through a *person's* whole history rather than looking up one row by
-- id. Their filters are `(passenger, status, requested_at)` and
-- `(driver, status, created_at)`, and without an index PostgreSQL answers each
-- page with a sequential scan and a sort of every ride in the database.
--
-- This file adds **indexes only**. No column, no constraint and no enum value
-- changes here: the read APIs need no new state, and adding one would mean the
-- writes had to learn about it too.
--
-- Everything below is idempotent and safe to re-run, like every other file in
-- this directory. The three non-partial indexes are also declared in
-- `prisma/schema.prisma` so `prisma migrate diff` stays clean; the partial one is
-- deliberately *not* declared, because Prisma cannot model a WHERE clause and
-- therefore ignores the index entirely (the same reason the four partial unique
-- indexes are invisible to it).
--
-- On direction: these are all ascending. A btree index is read backwards at
-- almost no cost, so an index on `(passenger_profile_id, status, requested_at)`
-- serves `ORDER BY requested_at DESC` exactly as well as a DESC index would --
-- and unlike a DESC index, Prisma can express it. The project's existing `DESC`
-- indexes predate that observation; the drift they cause is accepted.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The passenger's history, filtered by status
--
-- `ride_requests_passenger_requested_at_idx` (08-ride-requests.sql) already serves
-- the unfiltered list. This one extends the same prefix with `status`, so
-- `?status=COMPLETED` is an index range on all three columns rather than a filter
-- applied after the scan.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ride_requests_passenger_status_requested_at_idx
  ON ride_requests (passenger_profile_id, status, requested_at);


-- ---------------------------------------------------------------------------
-- 2. The driver's history, newest first
--
-- `id` is part of the index because it is the tie-breaker in the ORDER BY: two
-- pools accepted in the same microsecond still have one deterministic order, and
-- the index can produce it without a sort.
--
-- This does not replace `one_active_pool_per_driver` (09-driver-dispatch.sql),
-- which answers "which pool is this driver committed to right now" for the
-- current-pool endpoint. That is a partial unique index over four statuses; this
-- is a paging index over every pool the driver has ever driven.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ride_pools_driver_created_at_idx
  ON ride_pools (driver_profile_id, created_at, id);


-- ---------------------------------------------------------------------------
-- 3. The driver's history, filtered by status
--
-- Sequential statuses ("my completed rides", "what I am on now"), and the
-- tie-break is applied by the sort the index already produces.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ride_pools_driver_status_created_at_idx
  ON ride_pools (driver_profile_id, status, created_at);


-- ---------------------------------------------------------------------------
-- 4. The driver's history, filtered by when the trip finished
--
-- A date range on completion is the one filter that cannot use either index
-- above: a pool that is still running has NULL here, and a range over NULLs is
-- never what the caller meant. Partial, so the index holds only finished trips --
-- which is also what makes `WHERE completed_at IS NOT NULL` cheaper than the
-- alternative of scanning every forming pool in the system.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ride_pools_driver_completed_at_idx
  ON ride_pools (driver_profile_id, completed_at)
  WHERE completed_at IS NOT NULL;


COMMENT ON INDEX ride_requests_passenger_status_requested_at_idx IS
  'Serves the passenger history list with and without ?status=, newest first.';
COMMENT ON INDEX ride_pools_driver_created_at_idx IS
  'Serves the driver history list newest first, with `id` as the deterministic tie-breaker.';
COMMENT ON INDEX ride_pools_driver_status_created_at_idx IS
  'Serves the driver history list filtered by status.';
COMMENT ON INDEX ride_pools_driver_completed_at_idx IS
  'Serves the driver history list filtered by a completion date range.';
