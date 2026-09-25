import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { requireDriverProfileId, touchLastSeen } from './driver.service.js';
import { ApiError } from '../utils/ApiError.js';
import { requireEnumValue } from '../utils/validation.js';
import {
  ACTIVE_POOL_STATUSES,
  DEFAULT_REJECTION_REASON,
  DRIVER_AVAILABILITY,
  isOfferExpired,
  OFFER_STATUS,
  OFFER_TYPE,
  POOL_STATUS,
  POOL_STOP_STATUS,
  REJECTION_REASONS,
} from './dispatch.rules.js';
import {
  MATCHING_RULE_VERSION,
  PLAN_REJECTION,
  simulateOccupancy,
  STOP_TYPE,
  validatePlan,
} from './matching.rules.js';
import {
  addMemberToPool,
  createPoolForAcceptedOffer,
  findActivePoolForDriver,
  loadPoolForDto,
  lockPool,
  lockPoolStops,
} from './pool.service.js';
import { appendRideEvent, applyRideRequestTransition, lockRideRequest } from './ride-request.service.js';
import { RIDE_ACTOR_TYPE, RIDE_EVENT_TYPE, RIDE_REQUEST_STATUS } from './ride.status.js';

/**
 * The driver's side of dispatch: the offers they can see, and what happens when
 * they answer one.
 *
 * ---------------------------------------------------------------------------
 * THE TWO ANSWERS, AND WHY THEY ARE TRANSACTIONS
 * ---------------------------------------------------------------------------
 * Rejection is small: end the offer, record why, and let the dispatcher find
 * somebody else. Acceptance is the largest write in the project -- a pool, a
 * member, two stops, a request that stops waiting, a driver who stops being
 * available, an offer that ends, and six audit events -- and it is all one
 * transaction, so a half-matched ride cannot exist.
 *
 * ---------------------------------------------------------------------------
 * LOCK ORDER
 * ---------------------------------------------------------------------------
 * Every path that touches both a ride request and its offers takes the *ride
 * request's* row lock first and the offer's second. That single rule is what
 * stops acceptance and passenger cancellation deadlocking against each other:
 * both want the same two rows, so they must want them in the same order.
 * Whoever wins the request lock decides the outcome, and the other one sees it
 * and reports a conflict -- never both applied, never neither.
 *
 * The driver profile and the vehicle are locked after those, in that order, and
 * are the last thing taken before the pool is written.
 */

const inTransaction = (work) =>
  prisma.$transaction(work, { timeout: env.dispatch.transactionTimeoutMs });

const offerNotFound = (offerId) => new ApiError(404, `Dispatch offer "${offerId}" was not found`);

/** Locks one vehicle for the rest of the transaction. */
const lockVehicle = async (tx, vehicleId) => {
  await tx.$queryRawUnsafe(`SELECT id FROM vehicles WHERE id = $1::uuid FOR UPDATE`, vehicleId);
  return tx.vehicle.findUnique({
    where: { id: vehicleId },
    select: { id: true, name: true, seatCapacity: true, active: true, driverId: true },
  });
};

/**
 * The offer shape a driver may see.
 *
 * Two kinds of offer, two shapes, and only ever one of them:
 *
 *   * an `INITIAL_RIDE` offer proposes a ride that does not exist yet, so it
 *     shows the two places, the approach and the vehicle;
 *   * an `ADD_PASSENGER` offer proposes changing a pool the driver is already
 *     committed to, so it shows the whole plan: the stop order as it is and as it
 *     would become, what the extra driving costs, how long the new passenger
 *     waits, and how much longer the passengers already aboard would ride.
 *
 * `proposalSnapshot` was written at offer time and holds no passenger identity
 * beyond ids a driver never sees, so it is safe to return -- the passenger's
 * *display name* is looked up live rather than stored, so a renamed account does
 * not leave a stale name in dispatch history.
 *
 * Never exposed, for either kind: contact details, the candidate score, the
 * fingerprint, another passenger's fare, or anything about another driver. The
 * proposal is read-only by construction -- acceptance takes an offer id and reads
 * the stored plan, so a client has nothing to submit and nothing to edit.
 */
export const toOfferDto = (offer, { now = new Date(), pointCodes } = {}) => {
  const snapshot = offer.proposalSnapshot ?? {};
  const passengerName = offer.rideRequest?.passengerProfile?.user?.name ?? null;
  const displayName = passengerName ? { displayName: passengerName.split(/\s+/)[0] } : null;

  const shared = {
    offerId: offer.id,
    status: offer.status,
    offerType: offer.offerType,
    expired: offer.status === OFFER_STATUS.PENDING ? isOfferExpired(offer, now) : false,
    offeredAt: new Date(offer.offeredAt).toISOString(),
    expiresAt: new Date(offer.expiresAt).toISOString(),
    respondedAt: offer.respondedAt ? new Date(offer.respondedAt).toISOString() : null,
    rejectionReason: offer.rejectionReason ?? null,
    rideRequestId: offer.rideRequestId,
    passenger: displayName,
    ridePoolId: offer.ridePoolId ?? null,
  };

  if (offer.offerType !== OFFER_TYPE.ADD_PASSENGER) {
    return {
      ...shared,
      pickup: snapshot.pickup ?? null,
      destination: snapshot.destination ?? null,
      passengerRoute: snapshot.passengerRoute ?? null,
      approach: snapshot.approach
        ? {
            distanceMeters: snapshot.approach.distanceMeters,
            durationSeconds: snapshot.approach.durationSeconds,
          }
        : null,
      vehicle: snapshot.vehicle ?? null,
    };
  }

  const code = (pointId) => {
    const found = pointCodes?.get(pointId);
    return found ? { code: found.code, name: found.name } : null;
  };
  const stops = (list, { withNew }) =>
    (list ?? []).map((stop) => ({
      sequence: stop.sequence,
      stopType: stop.stopType,
      servicePoint: code(stop.servicePointId),
      ...(withNew ? { isNew: Boolean(stop.isNew) } : {}),
    }));

  return {
    ...shared,
    poolVersion: offer.poolVersion ?? null,
    // The new passenger's own two places, taken from the request rather than from
    // the proposal, so a client can render the offer without parsing the plan.
    pickup: code(offer.rideRequest?.pickupServicePointId) ?? null,
    destination: code(offer.rideRequest?.dropoffServicePointId) ?? null,
    vehicle: offer.ridePool?.vehicle
      ? { name: offer.ridePool.vehicle.name, seatCapacity: offer.ridePool.vehicle.seatCapacity }
      : null,
    capacity: {
      seats: offer.ridePool?.capacitySnapshot ?? null,
      passengers: offer.ridePool?.members?.length ?? (snapshot.existingStops?.length ?? 0) / 2,
      peakOccupancy: snapshot.peakOccupancy ?? null,
    },
    added: {
      distanceMeters: snapshot.addedDistanceMeters ?? null,
      durationSeconds: snapshot.addedDurationSeconds ?? null,
    },
    // The new passenger's wait: how long they will have waited in total by the
    // time they are collected, and how long the driver takes to reach them.
    pickupWaitSeconds: snapshot.newPassengerPickupWaitSeconds ?? null,
    pickupEtaSeconds: snapshot.newPassengerDriverEtaSeconds ?? null,
    plannedPickupArrivalAt: snapshot.newPassengerPickupArrivalAt ?? null,
    maxExistingPassengerDetourSeconds: snapshot.worstExistingPassengerDetourSeconds ?? null,
    // "What it is now" and "what it would become", which is the decision the
    // driver is being asked to make.
    currentStops: stops(snapshot.existingStops, { withNew: false }),
    proposedStops: stops(snapshot.stops, { withNew: true }),
  };
};

/** What the driver DTO needs, plus the passenger name for the offer DTO. */
const OFFER_SELECT = {
  id: true,
  status: true,
  offerType: true,
  rideRequestId: true,
  driverProfileId: true,
  vehicleId: true,
  ridePoolId: true,
  poolVersion: true,
  approachDistanceMeters: true,
  approachDurationSeconds: true,
  score: true,
  offeredAt: true,
  expiresAt: true,
  respondedAt: true,
  rejectionReason: true,
  proposalSnapshot: true,
  rideRequest: {
    select: {
      id: true,
      status: true,
      pickupServicePointId: true,
      dropoffServicePointId: true,
      passengerProfile: { select: { user: { select: { name: true } } } },
    },
  },
  // Only read for an ADD_PASSENGER offer, so the driver can see the pool they
  // would be changing: its capacity and how full it currently is.
  ridePool: {
    select: {
      id: true,
      status: true,
      version: true,
      capacitySnapshot: true,
      vehicle: { select: { name: true, seatCapacity: true } },
      members: { select: { id: true } },
    },
  },
};

/**
 * The service point codes a set of offers mentions.
 *
 * A join proposal is stored as point ids (they are what the plan is built from),
 * so rendering it needs one lookup for the handful of places involved -- rather
 * than denormalising names into an audit snapshot that would then be able to
 * disagree with the table it came from.
 */
const loadPointCodes = async (offers) => {
  const pointIds = new Set();

  for (const offer of offers) {
    const snapshot = offer.proposalSnapshot ?? {};

    for (const stop of snapshot.stops ?? []) pointIds.add(stop.servicePointId);
    for (const stop of snapshot.existingStops ?? []) pointIds.add(stop.servicePointId);

    if (offer.rideRequest?.pickupServicePointId) pointIds.add(offer.rideRequest.pickupServicePointId);
    if (offer.rideRequest?.dropoffServicePointId) pointIds.add(offer.rideRequest.dropoffServicePointId);
  }

  const ids = [...pointIds].filter(Boolean);
  if (ids.length === 0) return new Map();

  const points = await prisma.servicePoint.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, name: true },
  });

  return new Map(points.map((point) => [point.id, point]));
};

/**
 * A driver's own offers, newest first.
 *
 * Defaults to the pending ones because that is the only set a driver can act on,
 * but any status can be asked for so a client can show what happened to an offer
 * that is over. Another driver's offers are unreachable by construction: the
 * filter is the authenticated driver's own profile id.
 */
export const listOffersForDriver = async ({
  driver,
  status = OFFER_STATUS.PENDING,
  limit = env.dispatch.listPageSize,
  now = new Date(),
}) => {
  const driverProfileId = requireDriverProfileId(driver);

  const where = {
    driverProfileId,
    ...(status === 'ALL' ? {} : { status }),
  };

  const offers = await prisma.dispatchOffer.findMany({
    where,
    select: OFFER_SELECT,
    orderBy: [{ offeredAt: 'desc' }],
    take: limit,
  });

  // Reading the offer list is one of the moments the driver proves they are
  // still there, which is what keeps them eligible for the next one.
  await touchLastSeen(driverProfileId, now);

  const pointCodes = await loadPointCodes(offers);

  return offers.map((offer) => toOfferDto(offer, { now, pointCodes }));
};

/** One of the driver's own offers. Somebody else's is a 404, not a 403. */
export const findOfferForDriver = async ({ driver, offerId, now = new Date() }) => {
  const driverProfileId = requireDriverProfileId(driver);

  const offer = await prisma.dispatchOffer.findUnique({
    where: { id: offerId },
    select: OFFER_SELECT,
  });

  if (!offer || offer.driverProfileId !== driverProfileId) throw offerNotFound(offerId);

  const pointCodes = await loadPointCodes([offer]);

  return toOfferDto(offer, { now, pointCodes });
};

/**
 * Refuses an offer, and leaves everything else exactly as it was.
 *
 * The four things a rejection must NOT do are the point of the operation: the
 * passenger's request stays WAITING, no pool exists, the driver is not reserved,
 * and the ride is not cancelled. The driver is simply not the one, and the
 * dispatcher is asked for the next candidate after the commit -- outside the
 * transaction, so a slow routing search cannot hold a row lock.
 *
 * An offer that has already expired is expired rather than rejected: two
 * different facts, and the passenger's timeline should say which one happened.
 */
export const rejectOffer = async ({
  driver,
  offerId,
  reason = DEFAULT_REJECTION_REASON,
  now = new Date(),
}) => {
  const driverProfileId = requireDriverProfileId(driver);

  // The vocabulary is shared with the route validator, so "too_far" is
  // understood and "WHATEVER" is refused before any row is read.
  const normalizedReason = requireEnumValue(reason, REJECTION_REASONS, 'reason');

  // Read first, without a lock, only to learn which request to lock first.
  const located = await prisma.dispatchOffer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      driverProfileId: true,
      rideRequestId: true,
      offerType: true,
      ridePoolId: true,
      poolVersion: true,
    },
  });

  if (!located || located.driverProfileId !== driverProfileId) throw offerNotFound(offerId);

  const isJoinOffer = located.offerType === OFFER_TYPE.ADD_PASSENGER;

  const outcome = await inTransaction(async (tx) => {
    // Request first, then offer: the one lock order the whole milestone uses.
    const request = await lockRideRequest(tx, located.rideRequestId);

    const offer = await tx.dispatchOffer.findUnique({
      where: { id: offerId },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        driverProfileId: true,
        rideRequestId: true,
        offerType: true,
        ridePoolId: true,
        poolVersion: true,
      },
    });

    if (!offer || offer.driverProfileId !== driverProfileId) throw offerNotFound(offerId);

    if (offer.status !== OFFER_STATUS.PENDING) {
      throw new ApiError(
        409,
        `This offer is already ${offer.status.toLowerCase()} and cannot be answered`,
      );
    }

    if (isOfferExpired(offer, now)) {
      await tx.dispatchOffer.update({
        where: { id: offer.id },
        data: { status: OFFER_STATUS.EXPIRED, respondedAt: now },
      });

      if (request) {
        await appendRideEvent(tx, {
          rideRequestId: offer.rideRequestId,
          eventType: RIDE_EVENT_TYPE.DRIVER_OFFER_EXPIRED,
          actorType: RIDE_ACTOR_TYPE.SYSTEM,
          previousStatus: request.status,
          newStatus: request.status,
          metadata: {
            offerId: offer.id,
            driverProfileId: offer.driverProfileId,
            offerType: offer.offerType,
            ridePoolId: offer.ridePoolId,
            expiresAt: offer.expiresAt.toISOString(),
          },
          now,
        });
      }

      return { expired: true, rideRequestId: offer.rideRequestId, offerType: offer.offerType };
    }

    await tx.dispatchOffer.update({
      where: { id: offer.id },
      data: {
        status: OFFER_STATUS.REJECTED,
        respondedAt: now,
        rejectionReason: normalizedReason,
      },
    });

    if (request) {
      await appendRideEvent(tx, {
        rideRequestId: offer.rideRequestId,
        // A refused join and a refused ride are different facts: the first says
        // "not in my car", the second "not my fare". The timeline keeps them
        // apart so the next attempt can be explained.
        eventType: isJoinOffer
          ? RIDE_EVENT_TYPE.POOL_JOIN_REJECTED
          : RIDE_EVENT_TYPE.DRIVER_REJECTED,
        actorType: RIDE_ACTOR_TYPE.SYSTEM,
        previousStatus: request.status,
        newStatus: request.status,
        metadata: {
          offerId: offer.id,
          driverProfileId: offer.driverProfileId,
          reason: normalizedReason,
          ...(isJoinOffer
            ? {
                ridePoolId: offer.ridePoolId,
                poolVersion: offer.poolVersion,
                ruleVersion: MATCHING_RULE_VERSION,
              }
            : {}),
        },
        now,
      });
    }

    return {
      expired: false,
      rideRequestId: offer.rideRequestId,
      offerType: offer.offerType,
      ridePoolId: offer.ridePoolId,
    };
  });

  await touchLastSeen(driverProfileId, now);

  if (outcome.expired) {
    throw new ApiError(409, 'This offer has expired and can no longer be answered');
  }

  return {
    rejected: true,
    offerId,
    offerType: outcome.offerType,
    rideRequestId: outcome.rideRequestId,
    ridePoolId: outcome.ridePoolId ?? null,
    reason: normalizedReason,
  };
};

/**
 * Accepts an offer and creates the pool.
 *
 * The order of the checks is the order of the brief, and every one of them is
 * re-read under a lock: the offer, the request, the driver and the vehicle were
 * all true when the offer was made, and none of them has to still be true now.
 * Anything that changed means a controlled 409 and a rolled-back transaction --
 * never a partial match.
 *
 * The route is *not* recomputed. The offer carries the approach it was made with,
 * and acceptance verifies the driver is still at the point that approach was
 * measured from; re-routing inside the transaction would add a pgRouting call to
 * the critical section, and the passenger already agreed to the journey in the
 * quote the request froze.
 */
export const acceptOffer = async ({ driver, offerId, now = new Date() }) => {
  const driverProfileId = requireDriverProfileId(driver);

  const located = await prisma.dispatchOffer.findUnique({
    where: { id: offerId },
    select: { id: true, driverProfileId: true, rideRequestId: true, offerType: true },
  });

  if (!located || located.driverProfileId !== driverProfileId) throw offerNotFound(offerId);

  // Two kinds of offer, two very different transactions: one starts a pool, the
  // other changes one. Both lock the request first, so they cannot deadlock
  // against each other or against a passenger's cancellation.
  if (located.offerType === OFFER_TYPE.ADD_PASSENGER) {
    const outcome = await acceptAddPassengerOffer({ driver, driverProfileId, offerId, now });

    if (outcome.expired) {
      throw new ApiError(409, 'This offer has expired and can no longer be accepted');
    }

    const pool = await loadPoolForDto(outcome.ridePoolId);

    return { pool, rideRequestId: outcome.rideRequestId, joined: true };
  }

  const outcome = await acceptInitialRideOffer({
    driver,
    driverProfileId,
    offerId,
    rideRequestId: located.rideRequestId,
    now,
  });

  return { ...outcome, joined: false };
};

/**
 * Accepts an initial offer: locks the request, then the offer, then the driver,
 * the vehicle and the pool slot, and writes the pool, its member and its two
 * stops in one transaction.
 *
 * Every check is re-read under a lock, because the offer was made from state that
 * does not have to still be true.
 */
const acceptInitialRideOffer = async ({ driver, driverProfileId, offerId, rideRequestId, now }) => {
  const outcome = await inTransaction(async (tx) => {
    // 1-2. Lock the ride request, then the offer.
    const request = await lockRideRequest(tx, rideRequestId);

    const offer = await tx.dispatchOffer.findUnique({
      where: { id: offerId },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        driverProfileId: true,
        rideRequestId: true,
        vehicleId: true,
        approachDurationSeconds: true,
        proposalSnapshot: true,
      },
    });

    // 3. It has to be this driver's own pending offer.
    if (!offer || offer.driverProfileId !== driverProfileId) throw offerNotFound(offerId);

    if (offer.status !== OFFER_STATUS.PENDING) {
      throw new ApiError(
        409,
        `This offer is already ${offer.status.toLowerCase()} and cannot be accepted`,
      );
    }

    // 4. ...and it has to still be inside its window.
    if (isOfferExpired(offer, now)) {
      await tx.dispatchOffer.update({
        where: { id: offer.id },
        data: { status: OFFER_STATUS.EXPIRED, respondedAt: now },
      });

      if (request) {
        await appendRideEvent(tx, {
          rideRequestId: offer.rideRequestId,
          eventType: RIDE_EVENT_TYPE.DRIVER_OFFER_EXPIRED,
          actorType: RIDE_ACTOR_TYPE.SYSTEM,
          previousStatus: request.status,
          newStatus: request.status,
          metadata: {
            offerId: offer.id,
            driverProfileId: offer.driverProfileId,
            expiresAt: offer.expiresAt.toISOString(),
          },
          now,
        });
      }

      return { expired: true, rideRequestId: offer.rideRequestId };
    }

    // 5-6. The request is still waiting for a driver.
    if (!request) throw new ApiError(404, `Ride request "${offer.rideRequestId}" was not found`);

    if (request.status !== RIDE_REQUEST_STATUS.WAITING) {
      throw new ApiError(
        409,
        `This ride request is no longer waiting for a driver (${request.status})`,
      );
    }

    // 7. ...and is not already in somebody's pool.
    const existingMember = await tx.poolMember.findUnique({
      where: { rideRequestId: request.id },
      select: { id: true, ridePoolId: true },
    });
    if (existingMember) {
      throw new ApiError(409, 'This ride request already belongs to a pool');
    }

    // 8-10. The driver is still exactly who the dispatcher chose.
    await tx.$queryRawUnsafe(
      `SELECT id FROM driver_profiles WHERE id = $1::uuid FOR UPDATE`,
      driverProfileId,
    );

    const driverRow = await tx.driverProfile.findUnique({
      where: { id: driverProfileId },
      select: {
        id: true,
        status: true,
        currentServicePointId: true,
        activeVehicleId: true,
      },
    });

    if (!driverRow || driverRow.status !== DRIVER_AVAILABILITY.AVAILABLE) {
      throw new ApiError(
        409,
        `A driver who is ${driverRow?.status ?? 'unknown'} cannot accept a ride`,
      );
    }

    // 11. The point they were offered at is still a place a passenger can be
    // collected from, and it is still the point the approach was measured from.
    const point = await tx.servicePoint.findUnique({
      where: { id: driverRow.currentServicePointId },
      select: { id: true, code: true, name: true, active: true },
    });

    const offeredFromPointCode = offer.proposalSnapshot?.approach?.fromServicePointCode ?? null;

    if (!point || !point.active) {
      throw new ApiError(409, 'Your current service point is no longer available for pickups');
    }

    if (offeredFromPointCode && offeredFromPointCode !== point.code) {
      throw new ApiError(
        409,
        'You have moved since this offer was made; the offer no longer describes your approach',
      );
    }

    // 12. The vehicle is still usable, and still the one that was offered.
    const vehicle = await lockVehicle(tx, driverRow.activeVehicleId);

    if (!vehicle || !vehicle.active || vehicle.seatCapacity <= 0) {
      throw new ApiError(409, 'Your vehicle is no longer active with capacity');
    }

    if (vehicle.id !== offer.vehicleId) {
      throw new ApiError(409, 'Your active vehicle has changed since this offer was made');
    }

    // 13. One active pool per driver. The partial unique index is the real guard;
    // this is the message.
    const activePool = await tx.ridePool.findFirst({
      where: { driverProfileId, status: { in: ACTIVE_POOL_STATUSES } },
      select: { id: true },
    });
    if (activePool) {
      throw new ApiError(409, 'You already have an active ride pool');
    }

    // 14. The plan comes from the quote the passenger accepted.
    const quote = await tx.fareQuote.findUnique({
      where: { id: request.fareQuoteId },
      select: { routeSnapshot: true },
    });

    // 15-19. The pool, its member and its two stops.
    const created = await createPoolForAcceptedOffer(tx, {
      request,
      driverProfileId,
      vehicle,
      approachDurationSeconds: offer.approachDurationSeconds,
      routeGeometry: quote?.routeSnapshot?.geometry ?? null,
      actorUserId: driver.id,
      now,
    });

    // 20. The request stops waiting. This is the match, and it is written by the
    // one function allowed to change a ride request's status.
    await applyRideRequestTransition(tx, {
      request,
      toStatus: RIDE_REQUEST_STATUS.MATCHED,
      eventType: RIDE_EVENT_TYPE.PASSENGER_MATCHED,
      actorType: RIDE_ACTOR_TYPE.SYSTEM,
      actorUserId: null,
      metadata: {
        ridePoolId: created.pool.id,
        driverProfileId,
        vehicleId: vehicle.id,
        poolMemberId: created.member.id,
      },
      now,
    });

    // 21. The driver is committed until the trip ends.
    await tx.driverProfile.update({
      where: { id: driverProfileId },
      data: {
        status: DRIVER_AVAILABILITY.RESERVED,
        availableSince: null,
        lastSeenAt: now,
      },
    });

    // 22-23. The offer ends, and points at what its acceptance created.
    await tx.dispatchOffer.update({
      where: { id: offer.id },
      data: {
        status: OFFER_STATUS.ACCEPTED,
        respondedAt: now,
        ridePoolId: created.pool.id,
      },
    });

    // 24. And the ride request's own timeline records who accepted.
    await appendRideEvent(tx, {
      rideRequestId: request.id,
      eventType: RIDE_EVENT_TYPE.DRIVER_ACCEPTED,
      actorType: RIDE_ACTOR_TYPE.SYSTEM,
      previousStatus: RIDE_REQUEST_STATUS.WAITING,
      newStatus: RIDE_REQUEST_STATUS.MATCHED,
      metadata: { offerId: offer.id, driverProfileId, ridePoolId: created.pool.id },
      now,
    });

    return { expired: false, ridePoolId: created.pool.id, rideRequestId: request.id };
  });

  if (outcome.expired) {
    throw new ApiError(409, 'This offer has expired and can no longer be accepted');
  }

  const pool = await loadPoolForDto(outcome.ridePoolId);

  return { pool, rideRequestId: outcome.rideRequestId };
};

/**
 * Accepts an `ADD_PASSENGER` offer: inserts the passenger into a pool that is
 * already forming.
 *
 * This is the milestone's largest transaction, and the checks are the whole point
 * of it. Everything the plan was built from is re-read under a lock, because the
 * plan was measured outside any transaction and *nothing* it assumed has to still
 * be true:
 *
 *   1. the request is still `WAITING` and still unclaimed;
 *   2. the pool is still `FORMING`, still this driver's, and still on the version
 *      the plan was planned against;
 *   3. the driver is still the one assigned to it;
 *   4. capacity is recomputed from the members that exist now -- never trusted
 *      from the offer, which is how two passengers could otherwise take the last
 *      seat;
 *   5. every stop is still `PENDING`, and the stops the plan described are
 *      exactly the stops that exist, in the same order;
 *   6. the plan still fits the vehicle, segment by segment;
 *   7. the wait and detour limits still pass, with the wait re-measured against
 *      the clock as it is *now* -- a plan can become unkind simply by being
 *      accepted late.
 *
 * Nothing is re-routed: the stored proposal carries the leg durations, so the
 * arrivals are re-anchored to this instant arithmetically. Re-routing every leg
 * would put twenty pgRouting calls inside the critical section, and the version
 * check plus the stop-identity check already prove the plan still describes this
 * pool.
 */
const acceptAddPassengerOffer = async ({ driver, driverProfileId, offerId, now }) => {
  const outcome = await inTransaction(async (tx) => {
    const located = await tx.dispatchOffer.findUnique({
      where: { id: offerId },
      select: { rideRequestId: true },
    });

    if (!located) throw offerNotFound(offerId);

    // Request first, then the offer -- the lock order every path shares.
    const request = await lockRideRequest(tx, located.rideRequestId);

    const offer = await tx.dispatchOffer.findUnique({
      where: { id: offerId },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        offerType: true,
        driverProfileId: true,
        rideRequestId: true,
        ridePoolId: true,
        poolVersion: true,
        vehicleId: true,
        proposalSnapshot: true,
      },
    });

    if (!offer || offer.driverProfileId !== driverProfileId) throw offerNotFound(offerId);

    if (offer.offerType !== OFFER_TYPE.ADD_PASSENGER) {
      throw new ApiError(409, 'This offer does not propose a pool change');
    }

    if (offer.status !== OFFER_STATUS.PENDING) {
      throw new ApiError(
        409,
        `This offer is already ${offer.status.toLowerCase()} and cannot be accepted`,
      );
    }

    if (isOfferExpired(offer, now)) {
      await tx.dispatchOffer.update({
        where: { id: offer.id },
        data: { status: OFFER_STATUS.EXPIRED, respondedAt: now },
      });

      if (request) {
        await appendRideEvent(tx, {
          rideRequestId: offer.rideRequestId,
          eventType: RIDE_EVENT_TYPE.DRIVER_OFFER_EXPIRED,
          actorType: RIDE_ACTOR_TYPE.SYSTEM,
          previousStatus: request.status,
          newStatus: request.status,
          metadata: {
            offerId: offer.id,
            offerType: offer.offerType,
            ridePoolId: offer.ridePoolId,
            expiresAt: offer.expiresAt.toISOString(),
          },
          now,
        });
      }

      return { expired: true, rideRequestId: offer.rideRequestId };
    }

    if (!request) throw new ApiError(404, `Ride request "${offer.rideRequestId}" was not found`);

    if (request.status !== RIDE_REQUEST_STATUS.WAITING) {
      throw new ApiError(
        409,
        `This ride request is no longer waiting for a driver (${request.status})`,
      );
    }

    const existingMember = await tx.poolMember.findUnique({
      where: { rideRequestId: request.id },
      select: { id: true },
    });
    if (existingMember) throw new ApiError(409, 'This ride request already belongs to a pool');

    // --- The pool -----------------------------------------------------------
    const pool = await lockPool(tx, offer.ridePoolId);
    if (!pool) throw new ApiError(404, `Ride pool "${offer.ridePoolId}" was not found`);

    if (pool.driverProfileId !== driverProfileId) {
      throw new ApiError(409, 'This pool belongs to another driver');
    }

    if (pool.status !== POOL_STATUS.FORMING) {
      throw new ApiError(409, `This pool is ${pool.status.toLowerCase()} and can no longer be joined`);
    }

    if (offer.poolVersion !== null && pool.version !== offer.poolVersion) {
      // The pool has been re-planned since this offer was made, so the proposal
      // describes a stop order that no longer exists. The offer is cancelled
      // rather than left pending: nothing should keep waiting on a stale plan, and
      // the orchestrator will offer the request its next option.
      await tx.dispatchOffer.update({
        where: { id: offer.id },
        data: { status: OFFER_STATUS.CANCELLED, respondedAt: now },
      });

      await appendRideEvent(tx, {
        rideRequestId: offer.rideRequestId,
        eventType: RIDE_EVENT_TYPE.DRIVER_OFFER_CANCELLED,
        actorType: RIDE_ACTOR_TYPE.SYSTEM,
        previousStatus: request.status,
        newStatus: request.status,
        metadata: {
          offerId: offer.id,
          ridePoolId: pool.id,
          reason: 'stale_pool_version',
          offeredPoolVersion: offer.poolVersion,
          currentPoolVersion: pool.version,
        },
        now,
      });

      return { expired: false, stale: true, rideRequestId: offer.rideRequestId };
    }

    const driverRow = await tx.driverProfile.findUnique({
      where: { id: driverProfileId },
      select: { id: true, status: true, currentServicePointId: true },
    });

    if (!driverRow || driverRow.status !== DRIVER_AVAILABILITY.RESERVED) {
      throw new ApiError(409, 'You are no longer assigned to this pool');
    }

    // --- Capacity, recomputed from what exists now ---------------------------
    const members = await tx.poolMember.count({ where: { ridePoolId: pool.id } });
    if (members >= pool.capacitySnapshot) {
      throw new ApiError(409, 'This pool is full');
    }

    const stops = await lockPoolStops(tx, pool.id);
    if (stops.some((stop) => stop.status !== POOL_STOP_STATUS.PENDING)) {
      throw new ApiError(409, 'This pool already has a stop in progress and cannot be changed');
    }

    // --- The stored plan must still describe the stops that exist ------------
    const proposal = offer.proposalSnapshot;

    if (!proposal || proposal.ruleVersion !== MATCHING_RULE_VERSION) {
      throw new ApiError(409, 'This proposal was made under older matching rules and was refused');
    }

    if (proposal.poolId !== pool.id) {
      throw new ApiError(409, 'This proposal is about another pool');
    }

    const currentStopIds = stops.map((stop) => stop.id);
    const proposedExistingIds = proposal.stops
      .filter((stop) => !stop.isNew)
      .map((stop) => stop.stopId);

    if (
      proposedExistingIds.length !== currentStopIds.length ||
      proposedExistingIds.some((stopId, index) => stopId !== currentStopIds[index])
    ) {
      throw new ApiError(409, 'This pool has changed since the offer was made');
    }

    // --- The plan must still fit, and still be kind --------------------------
    const planStops = proposal.stops.map((stop) => ({
      sequence: stop.sequence,
      stopType: stop.stopType,
      memberKey: stop.isNew ? 'new' : stop.poolMemberId,
      servicePointId: stop.servicePointId,
    }));

    const occupancy = simulateOccupancy({ stops: planStops, capacity: pool.capacitySnapshot });

    if (!occupancy.valid) {
      throw new ApiError(409, 'This plan no longer fits the vehicle');
    }

    // Re-anchor the arrivals to now, exactly as the plan was built: the first stop
    // after the approach, each later stop after the legs before it.
    let elapsed = proposal.approach.durationSeconds;
    const arrivals = proposal.stops.map((stop, index) => {
      if (index > 0) elapsed += proposal.legs[index - 1].durationSeconds;
      return new Date(now.getTime() + elapsed * 1000);
    });

    const newPickupIndex = proposal.stops.findIndex(
      (stop) => stop.isNew && stop.stopType === STOP_TYPE.PICKUP,
    );

    const pickupWaitSeconds = Math.max(
      0,
      (arrivals[newPickupIndex].getTime() - new Date(request.requestedAt).getTime()) / 1000,
    );

    const verdict = validatePlan({
      occupancy,
      metrics: {
        pickupWaitSeconds,
        addedDurationSeconds: proposal.addedDurationSeconds,
        worstDetourSeconds: proposal.worstExistingPassengerDetourSeconds,
        passengerDurations: proposal.passengerDurations ?? [],
      },
      limits: {
        maxPickupWaitSeconds: env.matching.maxPickupWaitSeconds,
        maxAddedPoolDurationSeconds: env.matching.maxAddedPoolDurationSeconds,
        maxExistingPassengerDetourSeconds: env.matching.maxExistingPassengerDetourSeconds,
        maxExistingPassengerDetourRatio: env.matching.maxExistingPassengerDetourRatio,
      },
    });

    if (!verdict.valid) {
      throw new ApiError(
        409,
        `This join can no longer be made (${verdict.detail ?? verdict.reason ?? PLAN_REJECTION.PICKUP_WAIT})`,
      );
    }

    // --- Commit the join -----------------------------------------------------
    const added = await addMemberToPool(tx, {
      pool,
      request,
      proposal,
      actorUserId: driver.id,
      now,
    });

    await applyRideRequestTransition(tx, {
      request,
      toStatus: RIDE_REQUEST_STATUS.MATCHED,
      eventType: RIDE_EVENT_TYPE.PASSENGER_MATCHED,
      actorType: RIDE_ACTOR_TYPE.SYSTEM,
      actorUserId: null,
      metadata: {
        ridePoolId: pool.id,
        poolMemberId: added.member.id,
        driverProfileId,
        joinedExistingPool: true,
        ruleVersion: MATCHING_RULE_VERSION,
        poolVersionBefore: proposal.poolVersion,
        poolVersionAfter: added.version,
      },
      now,
    });

    await tx.dispatchOffer.update({
      where: { id: offer.id },
      data: { status: OFFER_STATUS.ACCEPTED, respondedAt: now },
    });

    await appendRideEvent(tx, {
      rideRequestId: request.id,
      eventType: RIDE_EVENT_TYPE.POOL_JOIN_ACCEPTED,
      actorType: RIDE_ACTOR_TYPE.SYSTEM,
      previousStatus: RIDE_REQUEST_STATUS.WAITING,
      newStatus: RIDE_REQUEST_STATUS.MATCHED,
      metadata: {
        offerId: offer.id,
        ridePoolId: pool.id,
        poolMemberId: added.member.id,
        ruleVersion: MATCHING_RULE_VERSION,
        score: proposal.score,
        addedDistanceMeters: proposal.addedDistanceMeters,
        addedDurationSeconds: proposal.addedDurationSeconds,
        pickupWaitSeconds,
        worstDetourSeconds: proposal.worstExistingPassengerDetourSeconds,
        poolVersionBefore: proposal.poolVersion,
        poolVersionAfter: added.version,
        stopOrder: proposal.stops.map((stop) => `${stop.sequence}:${stop.stopType}`),
      },
      now,
    });

    // The driver stays RESERVED: they were committed to this pool before the offer
    // and they are still committed to it after.
    return {
      expired: false,
      stale: false,
      rideRequestId: request.id,
      ridePoolId: pool.id,
      poolVersion: added.version,
    };
  });

  if (outcome.stale) {
    throw new ApiError(
      409,
      'This pool has changed since the offer was made; the ride will be offered again',
    );
  }

  return outcome;
};

/** The driver's current pool, or null. A driver has at most one active pool. */
export const getCurrentPoolForDriver = async ({ driver }) => {
  const driverProfileId = requireDriverProfileId(driver);

  const active = await findActivePoolForDriver(driverProfileId);
  if (!active) return null;

  return loadPoolForDto(active.id);
};
