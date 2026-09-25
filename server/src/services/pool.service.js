import { prisma } from '../db/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import {
  ACTIVE_POOL_STATUSES,
  DROPOFF_SEQUENCE,
  PICKUP_SEQUENCE,
  POOL_ACTOR_TYPE,
  POOL_EVENT_TYPE,
  POOL_MEMBER_STATUS,
  POOL_STATUS,
  POOL_STOP_STATUS,
  POOL_STOP_TYPE,
} from './dispatch.rules.js';

/**
 * Pools: the record of one accepted driver and the journey they agreed to.
 *
 * Only `FORMING` is created in this milestone. Everything here is written inside
 * the acceptance transaction in offer.service.js, so a pool cannot exist without
 * the member and the two stops that give it meaning -- and cannot exist at all
 * unless an offer was accepted.
 *
 * The pool is deliberately thin: it copies the vehicle's capacity (so a later
 * capacity change cannot rewrite it), points at the passenger's route as it was
 * quoted, and carries a `version` column nothing increments yet. Adding a second
 * passenger to a pool is a later milestone, and it will need optimistic
 * concurrency; the column is here so it does not need a migration.
 */

/** Locks one pool for the rest of the transaction. */
export const lockPool = async (tx, ridePoolId) => {
  await tx.$queryRawUnsafe(`SELECT id FROM ride_pools WHERE id = $1::uuid FOR UPDATE`, ridePoolId);
  return tx.ridePool.findUnique({ where: { id: ridePoolId } });
};

/** The next event number for a pool. The pool's row lock makes this race-free. */
const nextEventSequence = async (tx, ridePoolId) => {
  const rows = await tx.$queryRawUnsafe(
    `SELECT coalesce(max(sequence), 0)::int + 1 AS next_sequence
       FROM pool_events WHERE ride_pool_id = $1::uuid`,
    ridePoolId,
  );

  return Number(rows[0].next_sequence);
};

/**
 * Appends one event to a pool's history.
 *
 * Exported for the trip milestones, which will record arrival, pickup and
 * completion here. The caller must already hold the pool's row lock.
 */
export const appendPoolEvent = async (
  tx,
  { ridePoolId, eventType, actorType, actorUserId = null, metadata = {}, now },
) =>
  tx.poolEvent.create({
    data: {
      ridePoolId,
      sequence: await nextEventSequence(tx, ridePoolId),
      eventType,
      actorType,
      actorUserId,
      metadata,
      createdAt: now,
    },
  });

/**
 * Creates the pool, its single member and the two stops that order the journey.
 *
 * The plan is the passenger's own agreed journey: sequence 1 is the pickup at the
 * request's pickup service point, sequence 2 is the drop-off at its destination.
 * The geometry and the planned arrivals come from the quote the passenger
 * accepted, so the pool describes the ride that was priced rather than a
 * re-estimate against a graph that may have changed since.
 *
 * Must be called inside the acceptance transaction, after the ride request, the
 * offer, the driver profile and the vehicle have been locked.
 */
export const createPoolForAcceptedOffer = async (
  tx,
  {
    request,
    driverProfileId,
    vehicle,
    approachDurationSeconds,
    routeGeometry,
    actorUserId,
    now,
  },
) => {
  const pickupArrival = new Date(now.getTime() + approachDurationSeconds * 1000);
  const dropoffArrival = new Date(pickupArrival.getTime() + request.acceptedDurationSeconds * 1000);

  const pool = await tx.ridePool.create({
    data: {
      driverProfileId,
      vehicleId: vehicle.id,
      status: POOL_STATUS.FORMING,
      // The capacity the pool was planned with, copied rather than referenced.
      capacitySnapshot: vehicle.seatCapacity,
      plannedDistanceMeters: request.acceptedDistanceMeters,
      plannedDurationSeconds: request.acceptedDurationSeconds,
      acceptedAt: now,
      createdAt: now,
    },
    select: {
      id: true,
      status: true,
      version: true,
      capacitySnapshot: true,
      acceptedAt: true,
    },
  });

  // Prisma has no PostGIS types, so the one spatial column is written with
  // parameterised SQL -- the same rule the location seed and the routing read
  // follow. The geometry is the passenger's, taken from the accepted quote.
  if (routeGeometry) {
    await tx.$executeRawUnsafe(
      `UPDATE ride_pools
          SET planned_route_geometry = ST_SetSRID(ST_GeomFromGeoJSON($1::json), 4326)
        WHERE id = $2::uuid`,
      JSON.stringify(routeGeometry),
      pool.id,
    );
  }

  const member = await tx.poolMember.create({
    data: {
      ridePoolId: pool.id,
      rideRequestId: request.id,
      status: POOL_MEMBER_STATUS.ASSIGNED,
      matchedAt: now,
      createdAt: now,
    },
    select: { id: true, status: true, rideRequestId: true, matchedAt: true },
  });

  const pickupStop = await tx.poolStop.create({
    data: {
      ridePoolId: pool.id,
      rideRequestId: request.id,
      poolMemberId: member.id,
      servicePointId: request.pickupServicePointId,
      stopType: POOL_STOP_TYPE.PICKUP,
      sequence: PICKUP_SEQUENCE,
      status: POOL_STOP_STATUS.PENDING,
      plannedArrivalAt: pickupArrival,
    },
    select: { id: true, sequence: true },
  });

  const dropoffStop = await tx.poolStop.create({
    data: {
      ridePoolId: pool.id,
      rideRequestId: request.id,
      poolMemberId: member.id,
      servicePointId: request.dropoffServicePointId,
      stopType: POOL_STOP_TYPE.DROPOFF,
      sequence: DROPOFF_SEQUENCE,
      status: POOL_STOP_STATUS.PENDING,
      plannedArrivalAt: dropoffArrival,
    },
    select: { id: true, sequence: true },
  });

  await appendPoolEvent(tx, {
    ridePoolId: pool.id,
    eventType: POOL_EVENT_TYPE.POOL_CREATED,
    actorType: POOL_ACTOR_TYPE.DRIVER,
    actorUserId,
    metadata: {
      rideRequestId: request.id,
      vehicleId: vehicle.id,
      capacitySnapshot: vehicle.seatCapacity,
      status: POOL_STATUS.FORMING,
    },
    now,
  });

  await appendPoolEvent(tx, {
    ridePoolId: pool.id,
    eventType: POOL_EVENT_TYPE.MEMBER_ADDED,
    actorType: POOL_ACTOR_TYPE.DRIVER,
    actorUserId,
    metadata: { rideRequestId: request.id, poolMemberId: member.id },
    now,
  });

  await appendPoolEvent(tx, {
    ridePoolId: pool.id,
    eventType: POOL_EVENT_TYPE.ROUTE_PLAN_CREATED,
    actorType: POOL_ACTOR_TYPE.SYSTEM,
    metadata: {
      distanceMeters: request.acceptedDistanceMeters,
      durationSeconds: request.acceptedDurationSeconds,
      stops: [
        { sequence: pickupStop.sequence, stopType: POOL_STOP_TYPE.PICKUP },
        { sequence: dropoffStop.sequence, stopType: POOL_STOP_TYPE.DROPOFF },
      ],
    },
    now,
  });

  return { pool, member, stops: [pickupStop, dropoffStop] };
};

/** The driver's active pool, if they have one. A driver can have at most one. */
export const findActivePoolForDriver = (driverProfileId) =>
  prisma.ridePool.findFirst({
    where: { driverProfileId, status: { in: ACTIVE_POOL_STATUSES } },
    select: { id: true, status: true },
  });

/**
 * One pool with everything its DTO needs.
 *
 * The joins are a single Prisma query outside any transaction, which is the same
 * rule the rest of the project follows: relations are read after the commit, on
 * a pooled connection.
 */
export const loadPoolForDto = (ridePoolId) =>
  prisma.ridePool.findUnique({
    where: { id: ridePoolId },
    select: {
      id: true,
      status: true,
      version: true,
      capacitySnapshot: true,
      plannedDistanceMeters: true,
      plannedDurationSeconds: true,
      createdAt: true,
      acceptedAt: true,
      driverArrivedAt: true,
      startedAt: true,
      completedAt: true,
      cancelledAt: true,
      vehicle: { select: { name: true, seatCapacity: true } },
      members: {
        orderBy: { matchedAt: 'asc' },
        select: {
          id: true,
          status: true,
          matchedAt: true,
          rideRequestId: true,
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
          servicePoint: { select: { code: true, name: true } },
          poolMemberId: true,
        },
      },
      events: {
        orderBy: { sequence: 'asc' },
        select: { id: true, sequence: true, eventType: true, actorType: true, createdAt: true },
      },
    },
  });

/** One pool's history in order. Used by tests and by operators. */
export const listPoolEvents = (ridePoolId) =>
  prisma.poolEvent.findMany({
    where: { ridePoolId },
    orderBy: { sequence: 'asc' },
  });

/** A pool that does not exist and one that is not the caller's are the same answer. */
export const poolNotFound = (ridePoolId) =>
  new ApiError(404, `Ride pool "${ridePoolId}" was not found`);

export { ACTIVE_POOL_STATUSES };
