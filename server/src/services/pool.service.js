import { prisma } from '../db/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { POOL_FARE_STATUS } from './pool-fare.rules.js';
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

/**
 * Locks every stop of a pool for the rest of the transaction.
 *
 * Taken before a join rewrites the sequence numbers: without it, two joins into
 * the same pool would compute their final orders against stops the other is about
 * to move.
 */
export const lockPoolStops = async (tx, ridePoolId) => {
  await tx.$queryRawUnsafe(
    `SELECT id FROM pool_stops WHERE ride_pool_id = $1::uuid ORDER BY sequence FOR UPDATE`,
    ridePoolId,
  );

  return tx.poolStop.findMany({
    where: { ridePoolId },
    orderBy: { sequence: 'asc' },
    select: {
      id: true,
      sequence: true,
      stopType: true,
      servicePointId: true,
      rideRequestId: true,
      poolMemberId: true,
      status: true,
      plannedArrivalAt: true,
    },
  });
};

/**
 * The offset applied to existing sequences while a plan is being written.
 *
 * `pool_stops_pool_sequence_unique` is a plain unique constraint, so the final
 * sequence numbers cannot be assigned while the old ones are still in the way:
 * moving the stop at position 1 to position 3 collides with the stop currently at
 * position 3. Offsetting everything by a constant first -- and the offset is
 * comfortably larger than any plan this milestone can produce -- makes the whole
 * rewrite collision-free without needing deferrable constraints.
 *
 * The order the final values are then assigned in matters twice over: ascending
 * by final sequence means a passenger's pickup is always placed before their
 * drop-off, which is what the `enforce_pool_stop_consistency` trigger checks
 * whenever a drop-off is written.
 */
const SEQUENCE_OFFSET = 1000;

/**
 * Adds one passenger to a pool: the member, the two stops, the new plan and the
 * version bump, in the caller's transaction.
 *
 * `proposal` is the snapshot the driver accepted. Its stop order is authoritative
 * -- re-planned inside the transaction would mean routing every leg again, and the
 * plan was already validated against the pool version this transaction has just
 * confirmed is still current. What is recomputed here is everything that depends
 * on *when* it is applied: the arrivals are re-anchored to `now`, using the leg
 * durations the proposal stored.
 *
 * Must be called with the pool, its members and its stops locked.
 */
export const addMemberToPool = async (
  tx,
  { pool, request, proposal, actorUserId, now },
) => {
  const existingStops = await lockPoolStops(tx, pool.id);

  if (existingStops.some((stop) => stop.status !== POOL_STOP_STATUS.PENDING)) {
    throw new ApiError(409, 'This pool already has a stop in progress and cannot be changed');
  }

  const expectedVersion = proposal.poolVersion;

  // Re-anchor the accepted plan to the instant it is actually applied. The first
  // stop is reached after the approach, and each later stop after the legs before
  // it -- the same rule that planned it, evaluated against a later clock.
  let elapsed = proposal.approach.durationSeconds;
  const arrivals = proposal.stops.map((stop, index) => {
    if (index > 0) elapsed += proposal.legs[index - 1].durationSeconds;
    return new Date(now.getTime() + elapsed * 1000);
  });

  // 1. Move the existing stops out of the way of the sequences about to be used.
  await tx.$executeRawUnsafe(
    `UPDATE pool_stops SET sequence = sequence + $2::int WHERE ride_pool_id = $1::uuid`,
    pool.id,
    SEQUENCE_OFFSET,
  );

  // 2. The member. One row per passenger, and `ride_request_id` is unique, so the
  // database refuses a second membership even if two acceptances race.
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

  // 3. The two new stops, at the positions the proposal chose. Pickup first, so
  // the drop-off's consistency check finds its sibling already in place.
  const newStops = proposal.stops.filter((stop) => stop.isNew);
  const inserted = [];

  for (const stop of [...newStops].sort((a, b) => a.sequence - b.sequence)) {
    const created = await tx.poolStop.create({
      data: {
        ridePoolId: pool.id,
        rideRequestId: request.id,
        poolMemberId: member.id,
        servicePointId: stop.servicePointId,
        stopType: stop.stopType,
        sequence: stop.sequence,
        status: POOL_STOP_STATUS.PENDING,
        plannedArrivalAt: arrivals[stop.sequence - 1],
      },
      select: { id: true, sequence: true, stopType: true, servicePointId: true },
    });

    inserted.push(created);
  }

  // 4. Put the existing stops back, in ascending final order: a passenger's
  // pickup is always written before their drop-off, and never collides with a
  // sequence another stop still holds.
  const existingByPosition = new Map(
    proposal.stops
      .map((stop, index) => ({ stop, position: index + 1 }))
      .filter(({ stop }) => !stop.isNew)
      .map(({ stop, position }) => [position, stop]),
  );

  for (const position of [...existingByPosition.keys()].sort((a, b) => a - b)) {
    const stop = existingByPosition.get(position);

    await tx.poolStop.update({
      where: { id: stop.stopId },
      data: { sequence: position, plannedArrivalAt: arrivals[position - 1] },
      select: { id: true },
    });
  }

  // 5. The pool's plan and its version. The version is part of the WHERE clause,
  // so a proposal planned against a version that is no longer current cannot be
  // applied even if a caller forgot to check it first.
  if (proposal.routeGeometry) {
    await tx.$executeRawUnsafe(
      `UPDATE ride_pools
          SET planned_route_geometry = ST_SetSRID(ST_GeomFromGeoJSON($2::json), 4326),
              planned_distance_meters = $3,
              planned_duration_seconds = $4,
              version = version + 1
        WHERE id = $1::uuid AND version = $5`,
      pool.id,
      JSON.stringify(proposal.routeGeometry),
      proposal.totalDistanceMeters,
      proposal.totalDurationSeconds,
      expectedVersion,
    );
  } else {
    const updated = await tx.ridePool.updateMany({
      where: { id: pool.id, version: expectedVersion },
      data: {
        plannedDistanceMeters: proposal.totalDistanceMeters,
        plannedDurationSeconds: proposal.totalDurationSeconds,
        version: { increment: 1 },
      },
    });

    if (updated.count !== 1) {
      throw new ApiError(409, 'This pool has changed since the offer was made');
    }
  }

  // `$queryRawUnsafe` returns the rows themselves, not a `{ rows }` envelope --
  // only the test helper wraps it that way.
  const rows = await tx.$queryRawUnsafe(
    `SELECT version, planned_distance_meters::text AS distance, planned_duration_seconds
       FROM ride_pools WHERE id = $1::uuid`,
    pool.id,
  );

  if (!rows[0] || Number(rows[0].version) !== expectedVersion + 1) {
    throw new ApiError(409, 'This pool has changed since the offer was made');
  }

  await appendPoolEvent(tx, {
    ridePoolId: pool.id,
    eventType: POOL_EVENT_TYPE.MEMBER_ADDED,
    actorType: POOL_ACTOR_TYPE.DRIVER,
    actorUserId,
    metadata: {
      rideRequestId: request.id,
      poolMemberId: member.id,
      ruleVersion: proposal.ruleVersion,
      stopOrderSignature: proposal.stopOrderSignature,
    },
    now,
  });

  await appendPoolEvent(tx, {
    ridePoolId: pool.id,
    eventType: POOL_EVENT_TYPE.ROUTE_PLAN_UPDATED,
    actorType: POOL_ACTOR_TYPE.SYSTEM,
    metadata: {
      ruleVersion: proposal.ruleVersion,
      poolVersionBefore: expectedVersion,
      poolVersionAfter: Number(rows[0].version),
      addedDistanceMeters: proposal.addedDistanceMeters,
      addedDurationSeconds: proposal.addedDurationSeconds,
      peakOccupancy: proposal.peakOccupancy,
      stopOrder: proposal.stops.map((stop) => `${stop.sequence}:${stop.stopType}`),
    },
    now,
  });

  return {
    member,
    stops: inserted,
    version: Number(rows[0].version),
    plannedDistanceMeters: rows[0].distance,
    plannedDurationSeconds: rows[0].planned_duration_seconds,
  };
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
 * a pooled connection. The settled fare is read for its status only: the driver's
 * view of a pool carries no money, and `allowedActions` needs to know whether the
 * trip is cleared to start.
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
      departedAt: true,
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
          pickedUpAt: true,
          droppedOffAt: true,
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
          completedAt: true,
          servicePoint: { select: { code: true, name: true } },
          poolMemberId: true,
        },
      },
      // The fare the trip is running under (FINALIZED) or the current estimate.
      // Read only for its *status* and version: the driver's DTO carries no money,
      // and this is what tells them the trip is cleared to start.
      fareCalculations: {
        where: { status: { in: [POOL_FARE_STATUS.CURRENT, POOL_FARE_STATUS.FINALIZED] } },
        orderBy: [{ poolVersion: 'desc' }, { createdAt: 'desc' }],
        take: 1,
        select: { id: true, status: true, poolVersion: true, finalizedAt: true },
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
