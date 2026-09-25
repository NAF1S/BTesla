import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { requireDriverProfileId } from '../middleware/auth.js';
import { formatMoney } from './fare.calculator.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * The driver's *read* model: the pools they have driven, and one in detail.
 *
 * ---------------------------------------------------------------------------
 * WHY POOLS AND NOT RIDES
 * ---------------------------------------------------------------------------
 * A passenger's history is a list of their ride requests, because a request is
 * one passenger's journey. A driver's history is a list of *pools*, because a
 * pool is one car's journey: it may carry three passengers, it has one route, and
 * the driver did one job. Reporting a driver's history per ride request would
 * show a pooled trip three times and make "how many trips did I drive" impossible
 * to answer.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP
 * ---------------------------------------------------------------------------
 * `driverProfileId` is on every `where` clause and comes from the authenticated
 * user (`requireDriverProfileId`), never from a parameter. A pool id in a path is
 * checked against that driver's own rows, and somebody else's pool is a 404 --
 * never a 403, which would confirm the pool id exists and tell one driver that
 * another driver just drove a trip.
 *
 * ---------------------------------------------------------------------------
 * AVOIDING N+1
 * ---------------------------------------------------------------------------
 * A page of pools needs the pool, its vehicle, its passenger count and its latest
 * fare (one query, joined), plus the stops that give the summary its first and
 * final service point and its completed-stop count. The stops are read for the
 * whole page in a second query rather than per row -- see `loadStopsForPools`.
 * So a page costs three queries (count, pools, stops) whatever the page size.
 * `getRide` is a single pool with its own relations, where a handful of reads is
 * the right shape rather than a problem.
 */

const notFound = (ridePoolId) => new ApiError(404, `Ride pool "${ridePoolId}" was not found`);

const toIsoString = (value) => (value ? new Date(value).toISOString() : null);

/** The one stop that decides which way the trip ran: sequence 1. */
const firstStop = (stops) => stops[0] ?? null;
/** The last stop in the plan: where the driver ended up. */
const finalStop = (stops) => stops[stops.length - 1] ?? null;

/**
 * A driver's own vehicle, as their history reports it.
 *
 * The vehicle id is included because it is the driver's *own* asset -- they own
 * it, they may have several, and a history that cannot tell two cars apart is
 * useless to them. It is not a handle on anybody else.
 */
const toVehicleDto = (vehicle) =>
  vehicle
    ? { vehicleId: vehicle.id, name: vehicle.name, seatCapacity: vehicle.seatCapacity }
    : null;

/** The pooled plan's route, or the accepted fallback when there is no pool plan. */
const toRouteDto = (pool) => ({
  distanceMeters: Number(pool.plannedDistanceMeters),
  durationSeconds: pool.plannedDurationSeconds,
});

/**
 * A pool's fare, summarised for the driver who drove it.
 *
 * **Totals only.** The driver is told what the pool came to, how many passengers
 * were in it and whether the number is final -- not what any one passenger paid.
 * A per-passenger breakdown keyed by member would tell a driver exactly what the
 * person sitting behind them was charged, which is between the platform and that
 * passenger.
 *
 * Money appears in a driver's *history* and deliberately not in the pool they are
 * driving: mid-trip, a driver's decisions about a stop order should not depend on
 * what a passenger is paying. See `pool.serializer.js`, which reports only whether
 * the fare is settled.
 */
const toFareSummary = (calculation) => {
  if (!calculation) return null;

  const scale = calculation.pricingPolicy?.roundingScale;
  if (scale === undefined || scale === null) return null;

  return {
    fareStatus: calculation.status === 'FINALIZED' ? 'FINALIZED' : 'ESTIMATED',
    finalized: calculation.status === 'FINALIZED',
    finalizedAt: toIsoString(calculation.finalizedAt),
    currency: calculation.currency,
    poolVersion: calculation.poolVersion,
    // The whole pool: what every passenger in it was charged, added up.
    totalPassengerFare: formatMoney(calculation.totalFinalPassengerFare, scale),
  };
};

/**
 * The columns a history *row* needs.
 *
 * No member rows at all: a summary reports `passengerCount`, and reading every
 * member of every pool on the page to count them would be exactly the N+1 this
 * projection avoids. The count comes from `_count`, which Prisma resolves as a
 * subquery.
 */
const SUMMARY_SELECT = {
  id: true,
  status: true,
  capacitySnapshot: true,
  plannedDistanceMeters: true,
  plannedDurationSeconds: true,
  createdAt: true,
  acceptedAt: true,
  departedAt: true,
  driverArrivedAt: true,
  startedAt: true,
  completedAt: true,
  cancelledAt: true,
  vehicle: { select: { id: true, name: true, seatCapacity: true } },
  _count: { select: { members: true, stops: true } },
  fareCalculations: {
    orderBy: [{ poolVersion: 'desc' }, { createdAt: 'desc' }],
    take: 1,
    select: {
      id: true,
      status: true,
      poolVersion: true,
      currency: true,
      totalFinalPassengerFare: true,
      createdAt: true,
      finalizedAt: true,
      pricingPolicy: { select: { roundingScale: true } },
    },
  },
};

/**
 * The ordered stops of several pools, in one query.
 *
 * Ordered by pool and then by sequence, so a caller can group them in one pass
 * without sorting. `loadStopsForPools` returns a Map keyed by pool id.
 */
const loadStopsForPools = async (ridePoolIds) => {
  if (ridePoolIds.length === 0) return new Map();

  const stops = await prisma.poolStop.findMany({
    where: { ridePoolId: { in: ridePoolIds } },
    orderBy: [{ ridePoolId: 'asc' }, { sequence: 'asc' }],
    select: {
      id: true,
      ridePoolId: true,
      sequence: true,
      stopType: true,
      status: true,
      plannedArrivalAt: true,
      actualArrivalAt: true,
      completedAt: true,
      servicePoint: { select: { code: true, name: true } },
    },
  });

  const byPool = new Map();
  for (const stop of stops) {
    const list = byPool.get(stop.ridePoolId) ?? [];
    list.push(stop);
    byPool.set(stop.ridePoolId, list);
  }

  return byPool;
};

const completedStopCount = (stops) => stops.filter((stop) => stop.status === 'COMPLETED').length;

/**
 * The driver's history: newest first, filterable, paged.
 *
 * Ordering is `createdAt DESC, id DESC`. The tie-breaker matters for the same
 * reason it does on the passenger side: two pools accepted in the same
 * millisecond must come back in one fixed order, or a client paging through them
 * sees one twice and misses another. `ride_pools_driver_created_at_idx` carries
 * exactly this tuple, so the database produces the order rather than sorting.
 *
 * The date filter is a range on `createdAt` rather than on `completedAt`, because
 * `createdAt` is `NOT NULL` on every pool: filtering a list by a column that is
 * null on the pools a driver cares most about (the ones still running) would hide
 * them. A finished-trips-only view is `?status=COMPLETED` plus a range.
 */
export const listRidesForDriver = async ({
  driver,
  status = null,
  from = null,
  to = null,
  limit = env.dispatch.listPageSize,
  offset = 0,
}) => {
  const driverProfileId = requireDriverProfileId(driver);

  const createdAt = {};
  if (from) createdAt.gte = from;
  if (to) createdAt.lte = to;

  const where = {
    driverProfileId,
    ...(status ? { status } : {}),
    ...(from || to ? { createdAt } : {}),
  };

  const total = await prisma.ridePool.count({ where });

  const pools = await prisma.ridePool.findMany({
    where,
    select: SUMMARY_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: offset,
    take: limit,
  });

  const stopsByPool = await loadStopsForPools(pools.map((pool) => pool.id));

  return {
    rides: pools.map((pool) => {
      const stops = stopsByPool.get(pool.id) ?? [];

      return {
        pool,
        firstStop: firstStop(stops),
        finalStop: finalStop(stops),
        completedStops: completedStopCount(stops),
      };
    }),
    total,
    limit,
    offset,
  };
};

/**
 * One pool, in detail, but only if it is this driver's.
 *
 * Four reads: the pool with its members, stops and vehicle; its fare allocation
 * totals; its event log; and nothing else. The member rows are read here (unlike
 * in a summary) because a driver has to know who they are collecting and from
 * where -- that is the job.
 */
export const findRideForDriver = async ({ driver, ridePoolId }) => {
  const driverProfileId = requireDriverProfileId(driver);

  // Ownership is part of the read. A pool belonging to another driver is not
  // found, which is the same answer an unknown id gets.
  const pool = await prisma.ridePool.findFirst({
    where: { id: ridePoolId, driverProfileId },
    select: {
      ...SUMMARY_SELECT,
      members: {
        orderBy: { matchedAt: 'asc' },
        select: {
          id: true,
          status: true,
          matchedAt: true,
          pickedUpAt: true,
          droppedOffAt: true,
          rideRequest: {
            select: {
              id: true,
              status: true,
              pickupServicePoint: { select: { code: true, name: true } },
              dropoffServicePoint: { select: { code: true, name: true } },
              passengerProfile: { select: { user: { select: { name: true } } } },
            },
          },
        },
      },
      stops: {
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          sequence: true,
          stopType: true,
          status: true,
          plannedArrivalAt: true,
          actualArrivalAt: true,
          completedAt: true,
          poolMemberId: true,
          servicePoint: { select: { code: true, name: true } },
        },
      },
    },
  });

  if (!pool) throw notFound(ridePoolId);

  // The pool's own audit trail. `metadata` is not selected: the timeline mapper
  // turns types into sentences and never reads a payload.
  const events = await prisma.poolEvent.findMany({
    where: { ridePoolId },
    orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, sequence: true, eventType: true, actorType: true, createdAt: true },
  });

  return { pool, events };
};
