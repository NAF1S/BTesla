import { Role } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { requirePassengerProfileId } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { OFFER_STATUS } from './dispatch.rules.js';
import {
  ACTIVE_RIDE_REQUEST_STATUSES,
  canTransition,
  DEFAULT_CANCELLATION_REASON,
  isCancellable,
  RIDE_ACTOR_TYPE,
  RIDE_EVENT_TYPE,
  RIDE_REQUEST_STATUS,
  requestFingerprint,
} from './ride.status.js';

/**
 * The ride-request lifecycle.
 *
 * ---------------------------------------------------------------------------
 * ONE REQUEST IS ONE PASSENGER
 * ---------------------------------------------------------------------------
 * A request is one passenger travelling from one pickup point to one
 * destination point, accepting one quote. There is no seat count, no
 * requested-seat field and no per-seat arithmetic anywhere in this file; future
 * vehicle-capacity planning counts assigned passenger requests.
 *
 * ---------------------------------------------------------------------------
 * EVERY STATUS CHANGE GOES THROUGH `applyTransition`
 * ---------------------------------------------------------------------------
 * That one function is the only place a `ride_requests.status` is written, and
 * it always writes an event in the same transaction. The database enforces the
 * same transition table, so a status change that somehow bypassed this module
 * would be refused rather than recorded silently.
 *
 * Implemented here: WAITING -> MATCHED (by an accepted dispatch offer, in
 * offer.service.js), WAITING -> CANCELLED and WAITING -> EXPIRED.
 * Reserved (allowed by the database, unreachable from the API): MATCHED ->
 * IN_PROGRESS, MATCHED -> CANCELLED, IN_PROGRESS -> COMPLETED. The trip itself
 * belongs to a later milestone.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONSTRAINTS, NOT THE CHECKS, DECIDE RACES
 * ---------------------------------------------------------------------------
 * The three rules that matter under concurrency live in the database:
 * `fare_quote_id` is unique, `(passenger_profile_id, idempotency_key)` is
 * unique, and a partial unique index allows one active request per passenger.
 * The checks in this file exist to give a *good error message*; when two callers
 * race, the loser gets a uniqueness violation, and the loser then re-reads the
 * state to work out which of the three it was. Application checks alone would be
 * a race; they are a courtesy on top of the constraint, never the guard.
 */

/**
 * The relations a passenger response needs.
 *
 * Loaded **only outside a transaction**: inside one, Prisma resolves nested
 * relations by issuing several queries at once over the single connection the
 * transaction owns, which the PostgreSQL driver reports as deprecated (and will
 * refuse in pg@9). Inside a transaction this module reads scalars; the response
 * is assembled from a post-commit read of the row it just wrote.
 */
const RIDE_REQUEST_INCLUDE = {
  pickupServicePoint: { select: { id: true, code: true, name: true } },
  dropoffServicePoint: { select: { id: true, code: true, name: true } },
  // Read for the money format only: the rounding scale a fare is presented at is
  // stored on the quote, and the accepted fare is a copy of that same amount.
  fareQuote: { select: { fareBreakdown: true } },
};

/** The scalar row every lifecycle step works with. No relations, by design. */
export const RIDE_REQUEST_SCALARS = {
  id: true,
  passengerProfileId: true,
  fareQuoteId: true,
  pickupServicePointId: true,
  dropoffServicePointId: true,
  status: true,
  requestedAt: true,
  searchExpiresAt: true,
  startedAt: true,
  completedAt: true,
  cancelledAt: true,
  cancellationReason: true,
  idempotencyKey: true,
  requestFingerprint: true,
  acceptedFare: true,
  currency: true,
  acceptedPricingCode: true,
  acceptedPricingVersion: true,
  acceptedDistanceMeters: true,
  acceptedDurationSeconds: true,
};

const inTransaction = (work) =>
  prisma.$transaction(work, { timeout: env.rideRequests.transactionTimeoutMs });

/** Reads a committed request in the shape the passenger DTO needs. */
export const loadRideRequestForDto = (rideRequestId) =>
  prisma.rideRequest.findUnique({ where: { id: rideRequestId }, include: RIDE_REQUEST_INCLUDE });

/**
 * The PassengerProfile behind the authenticated user.
 *
 * The role guard on the route already rejects a driver, but this is also the
 * guarantee that a passenger request is *always* created for the caller: there
 * is no parameter anywhere in this module that could name another passenger.
 */
export const resolvePassengerProfileId = (user) => requirePassengerProfileId(user);

const notFound = (rideRequestId) =>
  new ApiError(404, `Ride request "${rideRequestId}" was not found`);

/** True when the error is a PostgreSQL uniqueness violation, however it arrives. */
const isUniqueViolation = (err) =>
  err?.code === 'P2002' ||
  err?.meta?.driverAdapterError?.cause?.originalCode === '23505' ||
  err?.meta?.driverAdapterError?.cause?.code === '23505';

/**
 * Locks one fare quote for the rest of the transaction.
 *
 * `SELECT ... FOR UPDATE` is the reason this is raw SQL: Prisma has no row-lock
 * API, and the lock is what serialises two requests trying to consume the same
 * quote. The row is then read through the ORM, so money arrives as a Decimal.
 */
const lockFareQuote = async (tx, fareQuoteId) => {
  await tx.$queryRawUnsafe(`SELECT id FROM fare_quotes WHERE id = $1::uuid FOR UPDATE`, fareQuoteId);
  return tx.fareQuote.findUnique({ where: { id: fareQuoteId } });
};

/** Locks one ride request for the rest of the transaction. */
export const lockRideRequest = async (tx, rideRequestId) => {
  await tx.$queryRawUnsafe(
    `SELECT id FROM ride_requests WHERE id = $1::uuid FOR UPDATE`,
    rideRequestId,
  );
  return tx.rideRequest.findUnique({ where: { id: rideRequestId } });
};

/** The next event number for a request; the row lock makes this race-free. */
const nextEventSequence = async (tx, rideRequestId) => {
  const rows = await tx.$queryRawUnsafe(
    `SELECT coalesce(max(sequence), 0)::int + 1 AS next_sequence
       FROM ride_events WHERE ride_request_id = $1::uuid`,
    rideRequestId,
  );

  return Number(rows[0].next_sequence);
};

/**
 * Appends one event to a request's history.
 *
 * Exported because the dispatch milestone writes to the same timeline: an offer,
 * a refusal, an expiry and a match are all things that happened to the
 * passenger's request, and they belong in the same ordered list as
 * RIDE_REQUESTED. The caller must already hold the request's row lock -- that is
 * what makes the sequence number race-free.
 */
export const appendRideEvent = async (
  tx,
  {
    rideRequestId,
    eventType,
    actorType,
    actorUserId = null,
    previousStatus = null,
    newStatus,
    metadata = {},
    now,
  },
) =>
  tx.rideEvent.create({
    data: {
      rideRequestId,
      sequence: await nextEventSequence(tx, rideRequestId),
      eventType,
      actorType,
      actorUserId,
      previousStatus,
      newStatus,
      metadata,
      createdAt: now,
    },
  });

/**
 * The one place a status changes.
 *
 * Writes the new status and appends the event that records it, inside the
 * caller's transaction, so "the status changed" and "history says why" are the
 * same commit -- there is no window in which one exists without the other.
 *
 * Exported because the dispatch milestone moves a request into MATCHED and the
 * trip milestone moves it into IN_PROGRESS and COMPLETED, and a second writer of
 * `status` would be a second place for the transition table to be wrong.
 *
 * `startedAt` and `completedAt` default to "leave it alone" rather than to null,
 * unlike the cancellation columns: a ride that is under way must keep the start
 * it was given when a *later* transition happens to it, and only the move that
 * means "this ride began/ended" supplies one. The lifecycle CHECK in
 * 12-driver-trip.sql is what refuses a status whose instants disagree with it.
 */
export const applyRideRequestTransition = async (
  tx,
  {
    request,
    toStatus,
    eventType,
    actorType,
    actorUserId = null,
    metadata = {},
    now,
    cancelledAt = null,
    cancellationReason = null,
    startedAt = undefined,
    completedAt = undefined,
  },
) => {
  if (!canTransition(request.status, toStatus)) {
    throw new ApiError(
      409,
      `A ride request cannot move from ${request.status} to ${toStatus}`,
    );
  }

  const updated = await tx.rideRequest.update({
    where: { id: request.id },
    data: { status: toStatus, cancelledAt, cancellationReason, startedAt, completedAt },
    select: RIDE_REQUEST_SCALARS,
  });

  await tx.rideEvent.create({
    data: {
      rideRequestId: request.id,
      sequence: await nextEventSequence(tx, request.id),
      eventType,
      actorType,
      actorUserId,
      previousStatus: request.status,
      newStatus: toStatus,
      metadata,
      createdAt: now,
    },
  });

  return updated;
};

/** The fingerprint the *incoming* request would have, from the quote it names. */
const fingerprintOfQuote = (passengerProfileId, quote) =>
  requestFingerprint({
    passengerProfileId,
    fareQuoteId: quote.id,
    pickupServicePointId: quote.originServicePointId,
    dropoffServicePointId: quote.destinationServicePointId,
    acceptedFare: quote.finalFare,
    currency: quote.currency,
    acceptedPricingCode: quote.pricingCode,
    acceptedPricingVersion: quote.pricingVersion,
    acceptedDistanceMeters: quote.distanceMeters,
    acceptedDurationSeconds: quote.durationSeconds,
  });

/**
 * Creates a passenger's ride request from a quote they own.
 *
 * Everything is one transaction: a request without its initial event, or an
 * event without its request, must be impossible, and any failure rolls both back.
 *
 * `now` is injectable so tests can pin the search window without touching the
 * clock.
 */
export const createRideRequest = async ({
  passenger,
  fareQuoteId,
  idempotencyKey,
  now = new Date(),
}) => {
  const passengerProfileId = resolvePassengerProfileId(passenger);

  const attempt = async () =>
    inTransaction(async (tx) => {
      // 2-3. Has this passenger already used this key?
      const prior = await tx.rideRequest.findUnique({
        where: {
          passengerProfileId_idempotencyKey: { passengerProfileId, idempotencyKey },
        },
        select: RIDE_REQUEST_SCALARS,
      });

      if (prior) {
        // The key identifies one request. Re-sending the same request returns it;
        // re-using the key for a different one is a conflict, not a new request.
        const incomingQuote = await tx.fareQuote.findUnique({ where: { id: fareQuoteId } });
        const incomingFingerprint = incomingQuote
          ? fingerprintOfQuote(passengerProfileId, incomingQuote)
          : null;

        if (incomingFingerprint !== prior.requestFingerprint) {
          throw new ApiError(
            409,
            `Idempotency-Key "${idempotencyKey}" was already used for a different ride request`,
          );
        }

        return { requestId: prior.id, replay: true };
      }

      // 4-5. Lock the quote first: from here until commit, no other request can
      // take it.
      const quote = await lockFareQuote(tx, fareQuoteId);
      if (!quote) throw new ApiError(404, `Fare quote "${fareQuoteId}" was not found`);

      // 6. Someone else's quote -- and an unowned legacy quote -- are reported
      // the same way, so this cannot be used to discover quotes that exist.
      if (quote.passengerProfileId !== passengerProfileId) {
        if (quote.passengerProfileId === null) {
          console.warn(`[rides] refusing unowned fare quote ${quote.id}`);
        }
        throw new ApiError(404, `Fare quote "${fareQuoteId}" was not found`);
      }

      // 7. A quote is only usable before it expires.
      if (quote.expiresAt.getTime() <= now.getTime()) {
        throw new ApiError(409, 'Fare quote has expired; request a new quote');
      }

      // 8. A quote is accepted at most once. The unique constraint is the real
      // guard; this is the message.
      const consumed = await tx.rideRequest.findUnique({
        where: { fareQuoteId: quote.id },
        select: {
          id: true,
          passengerProfileId: true,
          idempotencyKey: true,
          requestFingerprint: true,
        },
      });

      if (consumed) {
        // The quote may have been consumed by *this* request: two callers racing
        // with the same key can both miss the lookup above, and the loser only
        // finds out here, after the winner's commit released the quote lock. A
        // retry is not a conflict, so the same passenger, key and fingerprint
        // replays the request the winner created.
        if (
          consumed.passengerProfileId === passengerProfileId &&
          consumed.idempotencyKey === idempotencyKey &&
          consumed.requestFingerprint === fingerprintOfQuote(passengerProfileId, quote)
        ) {
          return { requestId: consumed.id, replay: true };
        }

        throw new ApiError(409, 'Fare quote has already been used by another ride request');
      }

      // 9. Both endpoints still have to be places a driver can actually reach.
      const points = await tx.servicePoint.findMany({
        where: { id: { in: [quote.originServicePointId, quote.destinationServicePointId] } },
        select: { id: true, active: true },
      });
      const inactive = points.filter((point) => !point.active);
      if (points.length < 2 || inactive.length > 0) {
        throw new ApiError(
          409,
          'A service point on this fare quote is no longer available for ride requests',
        );
      }

      // 10. One active request at a time. The partial unique index is the guard.
      const active = await tx.rideRequest.findFirst({
        where: { passengerProfileId, status: { in: ACTIVE_RIDE_REQUEST_STATUSES } },
        select: { id: true },
      });
      if (active) {
        throw new ApiError(
          409,
          'This passenger already has an active ride request; cancel or complete it first',
        );
      }

      // 11-12. Copy the accepted values and open the search window.
      const searchExpiresAt = new Date(now.getTime() + env.rideRequests.searchTtlSeconds * 1000);

      const created = await tx.rideRequest.create({
        data: {
          passengerProfileId,
          fareQuoteId: quote.id,
          pickupServicePointId: quote.originServicePointId,
          dropoffServicePointId: quote.destinationServicePointId,
          status: RIDE_REQUEST_STATUS.WAITING,
          requestedAt: now,
          searchExpiresAt,
          idempotencyKey,
          requestFingerprint: fingerprintOfQuote(passengerProfileId, quote),
          // Frozen copies: a later FarePolicy or quote change cannot alter what
          // this passenger accepted.
          acceptedFare: quote.finalFare,
          currency: quote.currency,
          acceptedPricingCode: quote.pricingCode,
          acceptedPricingVersion: quote.pricingVersion,
          acceptedDistanceMeters: quote.distanceMeters,
          acceptedDurationSeconds: quote.durationSeconds,
        },
        select: RIDE_REQUEST_SCALARS,
      });

      // 14. The first event, in the same transaction as the request itself.
      await tx.rideEvent.create({
        data: {
          rideRequestId: created.id,
          sequence: 1,
          eventType: RIDE_EVENT_TYPE.RIDE_REQUESTED,
          actorType: RIDE_ACTOR_TYPE.PASSENGER,
          actorUserId: passenger.id,
          previousStatus: null,
          newStatus: RIDE_REQUEST_STATUS.WAITING,
          metadata: { fareQuoteId: quote.id },
          createdAt: now,
        },
      });

      return { requestId: created.id, replay: false };
    });

  let outcome;
  try {
    outcome = await attempt();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (!isUniqueViolation(err)) throw err;

    // A racing caller won one of the three constraints. Work out which, from the
    // state they committed, and report that -- the request that exists is the
    // answer, whether it is the same request retried or a genuine conflict.
    const prior = await prisma.rideRequest.findUnique({
      where: { passengerProfileId_idempotencyKey: { passengerProfileId, idempotencyKey } },
      select: { id: true, requestFingerprint: true },
    });

    if (prior) {
      const quote = await prisma.fareQuote.findUnique({ where: { id: fareQuoteId } });
      const incomingFingerprint = quote ? fingerprintOfQuote(passengerProfileId, quote) : null;

      if (incomingFingerprint === prior.requestFingerprint) {
        // The same request, created by the caller that won the race.
        outcome = { requestId: prior.id, replay: true };
      } else {
        throw new ApiError(
          409,
          `Idempotency-Key "${idempotencyKey}" was already used for a different ride request`,
        );
      }
    } else {
      const consumed = await prisma.rideRequest.findUnique({
        where: { fareQuoteId },
        select: { id: true },
      });
      if (consumed) {
        throw new ApiError(409, 'Fare quote has already been used by another ride request');
      }

      const active = await prisma.rideRequest.findFirst({
        where: { passengerProfileId, status: { in: ACTIVE_RIDE_REQUEST_STATUSES } },
        select: { id: true },
      });
      if (active) {
        throw new ApiError(
          409,
          'This passenger already has an active ride request; cancel or complete it first',
        );
      }

      console.error('[rides] unexpected uniqueness conflict:', err.message);
      throw new ApiError(
        409,
        'The ride request could not be created because it conflicts with an existing one',
      );
    }
  }

  // The relations are read after the commit, on a normal pooled connection.
  const request = await loadRideRequestForDto(outcome.requestId);
  if (!request) throw new ApiError(500, 'The ride request could not be read back');

  return { request, replay: outcome.replay };
};

/** One request, but only if it belongs to this passenger. */
export const findRideRequestForPassenger = async ({ passenger, rideRequestId }) => {
  const passengerProfileId = resolvePassengerProfileId(passenger);

  const request = await prisma.rideRequest.findFirst({
    where: { id: rideRequestId, passengerProfileId },
    select: RIDE_REQUEST_SCALARS,
  });

  if (!request) throw notFound(rideRequestId);

  // Relations are read outside any transaction; see RIDE_REQUEST_INCLUDE.
  const withRelations = await loadRideRequestForDto(request.id);
  if (!withRelations) throw notFound(rideRequestId);

  return withRelations;
};

/** The passenger's own history: newest first, filterable by status, paged. */
export const listRideRequestsForPassenger = async ({
  passenger,
  status = null,
  limit = env.rideRequests.historyPageSize,
  offset = 0,
}) => {
  const passengerProfileId = resolvePassengerProfileId(passenger);

  // The passenger filter is part of every query below, so no page can ever
  // contain somebody else's request.
  const where = { passengerProfileId, ...(status ? { status } : {}) };

  // Sequential rather than `Promise.all`: the PostgreSQL adapter runs queries
  // over one client, and issuing two at once on it is deprecated in the driver
  // (and would be a race on a connection meant to be used one statement at a
  // time). Two small indexed queries are not worth the risk.
  const total = await prisma.rideRequest.count({ where });
  const requests = await prisma.rideRequest.findMany({
    where,
    include: RIDE_REQUEST_INCLUDE,
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    skip: offset,
    take: limit,
  });

  return { requests, total, limit, offset };
};

/**
 * Cancels a waiting request.
 *
 * Only WAITING may be cancelled in this milestone -- cancelling a matched
 * request needs a pool to release, and that belongs to the matching milestone.
 */
export const cancelRideRequest = async ({
  passenger,
  rideRequestId,
  reason = DEFAULT_CANCELLATION_REASON,
  now = new Date(),
}) => {
  const passengerProfileId = resolvePassengerProfileId(passenger);

  const cancelledId = await inTransaction(async (tx) => {
    const request = await lockRideRequest(tx, rideRequestId);

    // Not yours, or not there: the same answer either way.
    if (!request || request.passengerProfileId !== passengerProfileId) {
      throw notFound(rideRequestId);
    }

    if (request.status === RIDE_REQUEST_STATUS.CANCELLED) {
      throw new ApiError(409, 'Ride request has already been cancelled');
    }

    if (!isCancellable(request.status)) {
      throw new ApiError(
        409,
        `A ride request in status ${request.status} cannot be cancelled`,
      );
    }

    const updated = await applyRideRequestTransition(tx, {
      request,
      toStatus: RIDE_REQUEST_STATUS.CANCELLED,
      eventType: RIDE_EVENT_TYPE.RIDE_CANCELLED,
      actorType: RIDE_ACTOR_TYPE.PASSENGER,
      actorUserId: passenger.id,
      metadata: { reason },
      now,
      cancelledAt: now,
      cancellationReason: reason,
    });

    // Any driver still holding an offer for this ride is released in the same
    // transaction, under the request's lock. Acceptance takes the same lock
    // first, so it either wins outright or sees CANCELLED -- never both, and
    // never a pool for a cancelled ride. The driver stays AVAILABLE: a refusal
    // to be dispatched is a dispatcher decision, not a fault of theirs.
    const openOffers = await tx.dispatchOffer.findMany({
      where: { rideRequestId, status: OFFER_STATUS.PENDING },
      select: { id: true, driverProfileId: true },
    });

    if (openOffers.length > 0) {
      await tx.dispatchOffer.updateMany({
        where: { id: { in: openOffers.map((offer) => offer.id) } },
        data: { status: OFFER_STATUS.CANCELLED, respondedAt: now },
      });

      for (const offer of openOffers) {
        await appendRideEvent(tx, {
          rideRequestId,
          eventType: RIDE_EVENT_TYPE.DRIVER_OFFER_CANCELLED,
          actorType: RIDE_ACTOR_TYPE.SYSTEM,
          previousStatus: RIDE_REQUEST_STATUS.WAITING,
          newStatus: RIDE_REQUEST_STATUS.CANCELLED,
          metadata: { offerId: offer.id },
          now,
        });
      }
    }

    return updated.id;
  });

  // Relations are read after the commit, on a normal pooled connection.
  const request = await loadRideRequestForDto(cancelledId);
  if (!request) throw new ApiError(500, 'The ride request could not be read back');

  return request;
};

/**
 * Expires one overdue request, or reports that it was no longer expirable.
 *
 * Returns the updated request, or null when a concurrent cancellation (or an
 * earlier sweep) got there first -- which is a normal outcome, not an error: the
 * request is already in a legal terminal state.
 */
const expireOne = async (rideRequestId, now) => {
  try {
    return await inTransaction(async (tx) => {
      const request = await lockRideRequest(tx, rideRequestId);

      // Re-checked under the lock: cancellation may have won the race between the
      // sweep's candidate query and this transaction.
      if (!request || request.status !== RIDE_REQUEST_STATUS.WAITING) return null;
      if (request.searchExpiresAt.getTime() > now.getTime()) return null;

      return applyRideRequestTransition(tx, {
        request,
        toStatus: RIDE_REQUEST_STATUS.EXPIRED,
        eventType: RIDE_EVENT_TYPE.RIDE_EXPIRED,
        actorType: RIDE_ACTOR_TYPE.SYSTEM,
        actorUserId: null,
        metadata: { searchExpiresAt: request.searchExpiresAt.toISOString() },
        now,
      });
    });
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 409) return null;
    throw err;
  }
};

/**
 * Expires every WAITING request whose search window has closed.
 *
 * There is no scheduler in this project, so this is the operation a scheduler
 * would call: `npm run ride-requests:expire`, or the same function from a job.
 * Each request is expired in its own transaction, so one failure cannot roll
 * back another passenger's expiration.
 *
 * `now` is injectable, which is what makes the sweep testable without waiting.
 */
export const expireOverdueRideRequests = async ({ now = new Date(), limit = 500 } = {}) => {
  const candidates = await prisma.rideRequest.findMany({
    where: { status: RIDE_REQUEST_STATUS.WAITING, searchExpiresAt: { lte: now } },
    select: { id: true },
    orderBy: [{ searchExpiresAt: 'asc' }],
    take: limit,
  });

  const summary = { examined: candidates.length, expired: 0, skipped: 0 };

  for (const candidate of candidates) {
    const expired = await expireOne(candidate.id, now);
    if (expired) summary.expired += 1;
    else summary.skipped += 1;
  }

  return summary;
};

/** The stored events of one request, in order. Used by tests and by operators. */
export const listRideEvents = (rideRequestId) =>
  prisma.rideEvent.findMany({
    where: { rideRequestId },
    orderBy: { sequence: 'asc' },
  });
