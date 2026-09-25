import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { requireDriverProfileId, touchLastSeen } from './driver.service.js';
import { ApiError } from '../utils/ApiError.js';
import { requireEnumValue } from '../utils/validation.js';
import {
  ACTIVE_POOL_STATUSES,
  DEFAULT_REJECTION_REASON,
  DRIVER_AVAILABILITY,
  IMPLEMENTED_OFFER_TYPE,
  isOfferExpired,
  OFFER_STATUS,
  REJECTION_REASONS,
} from './dispatch.rules.js';
import { createPoolForAcceptedOffer, findActivePoolForDriver, loadPoolForDto } from './pool.service.js';
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
 * `proposalSnapshot` was written at offer time and holds no passenger identity,
 * so it is safe to return as-is. The passenger's *display name* is looked up live
 * rather than stored: a driver needs something to greet the rider with, and
 * keeping it out of the snapshot means a renamed or deleted account does not
 * leave a stale name in dispatch history.
 *
 * Never exposed: the passenger's contact details, the candidate score, the
 * fingerprint or anything about another driver.
 */
export const toOfferDto = (offer, { now = new Date() } = {}) => {
  const snapshot = offer.proposalSnapshot ?? {};
  const passengerName = offer.rideRequest?.passengerProfile?.user?.name ?? null;

  return {
    offerId: offer.id,
    status: offer.status,
    offerType: offer.offerType,
    expired: offer.status === OFFER_STATUS.PENDING ? isOfferExpired(offer, now) : false,
    offeredAt: new Date(offer.offeredAt).toISOString(),
    expiresAt: new Date(offer.expiresAt).toISOString(),
    respondedAt: offer.respondedAt ? new Date(offer.respondedAt).toISOString() : null,
    rejectionReason: offer.rejectionReason ?? null,
    rideRequestId: offer.rideRequestId,
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
    passenger: passengerName ? { displayName: passengerName.split(/\s+/)[0] } : null,
    ridePoolId: offer.ridePoolId ?? null,
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
      passengerProfile: { select: { user: { select: { name: true } } } },
    },
  },
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
    offerType: IMPLEMENTED_OFFER_TYPE,
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

  return offers.map((offer) => toOfferDto(offer, { now }));
};

/** One of the driver's own offers. Somebody else's is a 404, not a 403. */
export const findOfferForDriver = async ({ driver, offerId, now = new Date() }) => {
  const driverProfileId = requireDriverProfileId(driver);

  const offer = await prisma.dispatchOffer.findUnique({
    where: { id: offerId },
    select: OFFER_SELECT,
  });

  if (!offer || offer.driverProfileId !== driverProfileId) throw offerNotFound(offerId);

  return toOfferDto(offer, { now });
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
    select: { id: true, driverProfileId: true, rideRequestId: true },
  });

  if (!located || located.driverProfileId !== driverProfileId) throw offerNotFound(offerId);

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
            expiresAt: offer.expiresAt.toISOString(),
          },
          now,
        });
      }

      return { expired: true, rideRequestId: offer.rideRequestId };
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
        eventType: RIDE_EVENT_TYPE.DRIVER_REJECTED,
        actorType: RIDE_ACTOR_TYPE.SYSTEM,
        previousStatus: request.status,
        newStatus: request.status,
        metadata: { offerId: offer.id, driverProfileId: offer.driverProfileId, reason },
        now,
      });
    }

    return { expired: false, rideRequestId: offer.rideRequestId };
  });

  await touchLastSeen(driverProfileId, now);

  if (outcome.expired) {
    throw new ApiError(409, 'This offer has expired and can no longer be answered');
  }

  return {
    rejected: true,
    offerId,
    reason: normalizedReason,
    rideRequestId: outcome.rideRequestId,
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
    select: { id: true, driverProfileId: true, rideRequestId: true },
  });

  if (!located || located.driverProfileId !== driverProfileId) throw offerNotFound(offerId);

  const outcome = await inTransaction(async (tx) => {
    // 1-2. Lock the ride request, then the offer.
    const request = await lockRideRequest(tx, located.rideRequestId);

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

/** The driver's current pool, or null. A driver has at most one active pool. */
export const getCurrentPoolForDriver = async ({ driver }) => {
  const driverProfileId = requireDriverProfileId(driver);

  const active = await findActivePoolForDriver(driverProfileId);
  if (!active) return null;

  return loadPoolForDto(active.id);
};
