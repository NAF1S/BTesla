import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import {
  ACTIVE_POOL_STATUSES,
  bestCandidate,
  buildProposalSnapshot,
  candidateScore,
  DRIVER_AVAILABILITY,
  IMPLEMENTED_OFFER_TYPE,
  isOfferExpired,
  OFFER_STATUS,
  OFFER_TYPE,
} from './dispatch.rules.js';
import { isLocationFresh } from './driver.service.js';
import { estimateRoute } from './routing.service.js';
import { appendRideEvent, lockRideRequest } from './ride-request.service.js';
import { RIDE_ACTOR_TYPE, RIDE_EVENT_TYPE, RIDE_REQUEST_STATUS } from './ride.status.js';

/**
 * Sequential dispatch: choose one driver for one waiting ride request, offer it
 * to them, and only consider the next driver when that offer ends.
 *
 * ---------------------------------------------------------------------------
 * TWO-STAGE SEARCH
 * ---------------------------------------------------------------------------
 * Stage 1 is PostGIS: `ST_DWithin` on the passengers's pickup shortlists the
 * drivers whose reported service point is inside the configured radius. It
 * answers "who is worth routing?" and nothing else -- straight-line distance is
 * a filter, never the ranking, because 2 km across a river and 2 km down a road
 * are not the same offer.
 *
 * Stage 2 is the router: every shortlisted driver is routed from their current
 * service point to the pickup, and the *routed* duration decides. Drivers that
 * cannot be reached are dropped, and so are drivers whose approach is slower
 * than `DISPATCH_MAX_APPROACH_SECONDS`.
 *
 * The candidates are then scored (see dispatch.rules.js) and the single best one
 * is offered the ride.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENT BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 * `dispatchWaitingRequest` is safe to call repeatedly and concurrently:
 *
 *   * a request that is not WAITING, already has a pending offer, already has a
 *     pool member, or whose search window has closed is skipped, not failed;
 *   * the offer insert is guarded by the partial unique indexes
 *     `one_pending_initial_offer_per_request` and
 *     `one_pending_initial_offer_per_driver`, so two dispatchers racing produce
 *     one offer and one controlled skip.
 *
 * It never opens the ride request's own creation transaction: routing a
 * candidate is several database round trips and a pgRouting call, and a
 * passenger's 201 should not wait for them.
 */

/**
 * Stage 1. The spatial shortlist, with every filter a database can answer
 * pushed into the query.
 *
 * What is deliberately excluded here, and why it cannot be a service-level
 * afterthought: a driver who is not AVAILABLE, whose point is switched off, who
 * has not reported in recently (a stale location is not a location), who has no
 * usable vehicle, who already has an active pool, who is already considering
 * another offer, or who has already had *this* request and not taken it. Those
 * are exactly the exclusions the brief lists, and doing them in SQL means the
 * candidate list is already the eligible list.
 *
 * "Already had this request and not taken it" covers both a refusal and an
 * unanswered offer that ran out of time: either way the dispatcher must move on,
 * and re-offering to a driver who is not answering is how a request spends its
 * whole search window on one doorstep.
 *
 * The ride request id is `$4` rather than a reference to `$1`: `$1` is the
 * pickup's *service point*, and using it here would compare a service point id
 * with a ride request id and silently match nothing.
 */
const SHORTLIST_SQL = `
  SELECT dp.id                              AS driver_profile_id,
         dp.available_since                 AS available_since,
         dp.last_seen_at                    AS last_seen_at,
         dp.active_vehicle_id               AS active_vehicle_id,
         sp.code                            AS service_point_code,
         ST_Distance(sp.location, pickup.location)::float8 AS straight_line_meters
    FROM driver_profiles dp
    JOIN service_points sp     ON sp.id = dp.current_service_point_id
    JOIN service_points pickup ON pickup.id = $1::uuid
   WHERE dp.status = 'AVAILABLE'
     AND sp.active
     AND dp.last_seen_at IS NOT NULL
     AND dp.active_vehicle_id IS NOT NULL
     AND ST_DWithin(sp.location, pickup.location, $2::float8)
     AND EXISTS (
           SELECT 1 FROM vehicles v
            WHERE v.id = dp.active_vehicle_id AND v.active AND v.seat_capacity > 0
         )
     AND NOT EXISTS (
           SELECT 1 FROM ride_pools rp
            WHERE rp.driver_profile_id = dp.id
              AND rp.status IN ('FORMING', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS')
         )
     AND NOT EXISTS (
           SELECT 1 FROM dispatch_offers o
            WHERE o.driver_profile_id = dp.id
              AND o.status = 'PENDING'
              AND o.offer_type = 'INITIAL_RIDE'
         )
     AND NOT EXISTS (
           SELECT 1 FROM dispatch_offers spent
            WHERE spent.ride_request_id = $4::uuid
              AND spent.driver_profile_id = dp.id
              AND spent.status IN ('REJECTED', 'EXPIRED')
         )
   ORDER BY straight_line_meters ASC
   LIMIT $3::int`;

/**
 * The fairness terms, counted in one query for the whole shortlist rather than
 * one query per candidate.
 *
 * A recent refusal and a recent acceptance both make a driver a slightly worse
 * candidate than an identical driver who has done neither -- refusals because
 * the driver and the rides keep not matching, acceptances because they have
 * work in hand.
 */
const countRecentBehaviour = async (driverProfileIds, { now }) => {
  if (driverProfileIds.length === 0) return new Map();

  const rows = await prisma.$queryRawUnsafe(
    `SELECT driver_profile_id,
            count(*) FILTER (
              WHERE status = 'REJECTED' AND responded_at >= $2::timestamptz
            )::int AS recent_rejections,
            count(*) FILTER (
              WHERE status = 'ACCEPTED' AND responded_at >= $3::timestamptz
            )::int AS recent_acceptances
       FROM dispatch_offers
      WHERE driver_profile_id = ANY ($1::uuid[])
      GROUP BY driver_profile_id`,
    driverProfileIds,
    new Date(now.getTime() - env.dispatch.rejectionWindowSeconds * 1000),
    new Date(now.getTime() - env.dispatch.workloadWindowSeconds * 1000),
  );

  return new Map(
    rows.map((row) => [
      row.driver_profile_id,
      {
        recentRejections: Number(row.recent_rejections),
        acceptedOffersRecently: Number(row.recent_acceptances),
      },
    ]),
  );
};

/**
 * Stage 2. Routes every shortlisted driver to the pickup and returns the
 * candidates that survive, scored, in no particular order.
 *
 * A driver who cannot be routed to the pickup is not a candidate: pgRouting
 * answering "no path" is a real answer about this driver and this passenger, not
 * a failure of the search. The same applies to a service point that was switched
 * off between the shortlist and the route.
 */
const routeCandidates = async ({ shortlist, pickup, now }) => {
  const behaviour = await countRecentBehaviour(
    shortlist.map((row) => row.driver_profile_id),
    { now },
  );

  const candidates = [];

  for (const row of shortlist) {
    const counters = behaviour.get(row.driver_profile_id) ?? {
      recentRejections: 0,
      acceptedOffersRecently: 0,
    };

    // A driver already standing at the pickup point needs no route. Asking the
    // router for a journey from a place to itself is a 400, and it is not an
    // error -- it is the shortest possible approach.
    const samePoint = row.service_point_code === pickup.code;

    let approach = { distanceMeters: 0, durationSeconds: 0 };

    if (!samePoint) {
      try {
        const route = await estimateRoute({
          originServicePointCode: row.service_point_code,
          destinationServicePointCode: pickup.code,
          departureAt: now,
        });

        approach = {
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
        };
      } catch (err) {
        // "No path from this driver to this passenger" is a real answer about
        // this pair, not a failure of the search: the driver is skipped, the
        // next candidate is considered, and if nobody can reach the pickup the
        // request simply stays WAITING. A routing *failure* (a 500 -- bad graph
        // data, a broken query) is not a candidate property and is rethrown, so
        // it cannot be silently absorbed into "no drivers available".
        if (err instanceof ApiError && [400, 409, 422].includes(err.statusCode)) {
          continue;
        }
        throw err;
      }
    }

    if (approach.durationSeconds > env.dispatch.maxApproachDurationSeconds) {
      continue;
    }

    const availableSince = row.available_since ? new Date(row.available_since) : now;
    const idleSeconds = Math.max(0, Math.floor((now.getTime() - availableSince.getTime()) / 1000));

    candidates.push({
      driverProfileId: row.driver_profile_id,
      vehicleId: row.active_vehicle_id,
      servicePointCode: row.service_point_code,
      availableSince: row.available_since,
      straightLineMeters: Math.round(row.straight_line_meters),
      approachDistanceMeters: Math.round(approach.distanceMeters),
      approachDurationSeconds: approach.durationSeconds,
      idleSeconds,
      ...counters,
      score: candidateScore({
        approachDurationSeconds: approach.durationSeconds,
        recentRejections: counters.recentRejections,
        acceptedOffersRecently: counters.acceptedOffersRecently,
        idleSeconds,
        weights: env.dispatch.scoring,
      }),
    });
  }

  return candidates;
};

/** Chooses the best driver for one pickup, or null when nobody qualifies. */
export const selectCandidate = async ({
  pickupServicePointId,
  rideRequestId,
  now = new Date(),
  radiusMeters,
}) => {
  const pickup = await prisma.servicePoint.findUnique({
    where: { id: pickupServicePointId },
    select: { id: true, code: true, name: true, active: true },
  });

  if (!pickup || !pickup.active) return { candidate: null, candidates: [], pickup: null };

  const shortlist = await prisma.$queryRawUnsafe(
    SHORTLIST_SQL,
    pickup.id,
    radiusMeters ?? env.dispatch.shortlistRadiusMeters,
    env.dispatch.maxCandidates,
    rideRequestId,
  );

  const fresh = shortlist.filter((row) =>
    isLocationFresh({
      lastSeenAt: row.last_seen_at,
      now,
      freshnessSeconds: env.dispatch.locationFreshnessSeconds,
    }),
  );

  const candidates = await routeCandidates({ shortlist: fresh, pickup, now });

  return { candidate: bestCandidate(candidates), candidates, pickup };
};

const inTransaction = (work) =>
  prisma.$transaction(work, { timeout: env.dispatch.transactionTimeoutMs });

const skip = (reason, extra = {}) => ({ dispatched: false, reason, ...extra });

/** True when the error is a PostgreSQL uniqueness violation, however it arrives. */
const isUniqueViolation = (err) =>
  err?.code === 'P2002' ||
  err?.meta?.driverAdapterError?.cause?.originalCode === '23505' ||
  err?.meta?.driverAdapterError?.cause?.code === '23505';

/**
 * Offers a waiting request to its best candidate.
 *
 * Every precondition is re-checked under the ride request's row lock after the
 * search, because the search happened outside any transaction: the chosen driver
 * may have gone offline, taken another ride or been offered something else while
 * the router was working. A driver who is no longer eligible means no offer this
 * time -- the request stays WAITING, which is the correct answer and not a
 * failure.
 *
 * The same lock is the reason this is safe to run twice: the second run sees the
 * pending offer the first one wrote.
 */
export const dispatchWaitingRequest = async ({ rideRequestId, now = new Date(), radiusMeters }) => {
  // The request is read first, on its own, and the two cheap reasons to do
  // nothing -- it is not waiting, or its search window has closed -- are settled
  // before any routing work happens. Everything is re-checked under the row lock
  // inside the transaction; this is what keeps a stale or hopeless request from
  // costing twenty pgRouting calls.
  const request = await prisma.rideRequest.findUnique({
    where: { id: rideRequestId },
    select: { id: true, pickupServicePointId: true, status: true, searchExpiresAt: true },
  });

  if (!request) return skip('request_not_found');
  if (request.status !== RIDE_REQUEST_STATUS.WAITING) {
    return skip('request_not_waiting', { status: request.status });
  }
  if (request.searchExpiresAt.getTime() <= now.getTime()) {
    return skip('search_window_closed');
  }

  const { candidate, candidates } = await selectCandidate({
    pickupServicePointId: request.pickupServicePointId,
    rideRequestId,
    now,
    radiusMeters,
  });

  if (candidates.length === 0) {
    return skip('no_eligible_driver', { candidates: 0 });
  }

  if (!candidate) return skip('no_eligible_driver', { candidates: candidates.length });

  const outcome = await inTransaction(async (tx) => {
    const request = await lockRideRequest(tx, rideRequestId);

    if (!request) return skip('request_not_found');
    if (request.status !== RIDE_REQUEST_STATUS.WAITING) {
      return skip('request_not_waiting', { status: request.status });
    }
    if (request.searchExpiresAt.getTime() <= now.getTime()) {
      return skip('search_window_closed');
    }

    const openOffer = await tx.dispatchOffer.findFirst({
      where: { rideRequestId, status: OFFER_STATUS.PENDING },
      select: { id: true },
    });
    if (openOffer) return skip('already_offered', { offerId: openOffer.id });

    const member = await tx.poolMember.findUnique({
      where: { rideRequestId },
      select: { id: true },
    });
    if (member) return skip('already_in_pool', { poolMemberId: member.id });

    // Re-validate the chosen driver against the state that is true *now*.
    const driver = await tx.driverProfile.findUnique({
      where: { id: candidate.driverProfileId },
      select: {
        id: true,
        status: true,
        currentServicePointId: true,
        lastSeenAt: true,
        activeVehicleId: true,
      },
    });

    if (!driver || driver.status !== DRIVER_AVAILABILITY.AVAILABLE) {
      return skip('candidate_unavailable', { driverProfileId: candidate.driverProfileId });
    }
    if (
      !isLocationFresh({
        lastSeenAt: driver.lastSeenAt,
        now,
        freshnessSeconds: env.dispatch.locationFreshnessSeconds,
      })
    ) {
      return skip('candidate_stale', { driverProfileId: candidate.driverProfileId });
    }

    const activePool = await tx.ridePool.findFirst({
      where: { driverProfileId: driver.id, status: { in: ACTIVE_POOL_STATUSES } },
      select: { id: true },
    });
    if (activePool) {
      return skip('candidate_has_active_pool', { poolId: activePool.id });
    }

    const competingOffer = await tx.dispatchOffer.findFirst({
      where: {
        driverProfileId: driver.id,
        status: OFFER_STATUS.PENDING,
        offerType: IMPLEMENTED_OFFER_TYPE,
      },
      select: { id: true },
    });
    if (competingOffer) {
      return skip('candidate_already_offered', {
        driverProfileId: driver.id,
        offerId: competingOffer.id,
      });
    }

    const vehicle = await tx.vehicle.findUnique({
      where: { id: driver.activeVehicleId },
      select: { id: true, name: true, seatCapacity: true, active: true },
    });
    if (!vehicle || !vehicle.active || vehicle.seatCapacity <= 0) {
      return skip('candidate_vehicle_unusable', { driverProfileId: driver.id });
    }

    const points = await tx.servicePoint.findMany({
      where: { id: { in: [request.pickupServicePointId, request.dropoffServicePointId] } },
      select: { id: true, code: true, name: true, active: true },
    });
    const pickup = points.find((point) => point.id === request.pickupServicePointId);
    const destination = points.find((point) => point.id === request.dropoffServicePointId);

    if (!pickup || !destination || !pickup.active) {
      return skip('pickup_unavailable');
    }

    const expiresAt = new Date(now.getTime() + env.dispatch.offerTtlSeconds * 1000);

    const offer = await tx.dispatchOffer.create({
      data: {
        rideRequestId,
        driverProfileId: driver.id,
        vehicleId: vehicle.id,
        offerType: OFFER_TYPE.INITIAL_RIDE,
        status: OFFER_STATUS.PENDING,
        approachDistanceMeters: candidate.approachDistanceMeters,
        approachDurationSeconds: candidate.approachDurationSeconds,
        score: candidate.score,
        offeredAt: now,
        expiresAt,
        proposalSnapshot: buildProposalSnapshot({
          pickup,
          destination,
          approach: {
            fromServicePointCode: candidate.servicePointCode,
            distanceMeters: candidate.approachDistanceMeters,
            durationSeconds: candidate.approachDurationSeconds,
          },
          // The passenger's own agreed journey, already frozen on the request.
          passengerRoute: {
            distanceMeters: request.acceptedDistanceMeters,
            durationSeconds: request.acceptedDurationSeconds,
          },
          vehicle,
          requestedAt: request.requestedAt,
        }),
      },
      select: { id: true, expiresAt: true },
    });

    await appendRideEvent(tx, {
      rideRequestId,
      eventType: RIDE_EVENT_TYPE.DRIVER_OFFERED,
      actorType: RIDE_ACTOR_TYPE.SYSTEM,
      previousStatus: RIDE_REQUEST_STATUS.WAITING,
      newStatus: RIDE_REQUEST_STATUS.WAITING,
      metadata: { offerId: offer.id, driverProfileId: driver.id },
      now,
    });

    return {
      dispatched: true,
      offerId: offer.id,
      driverProfileId: driver.id,
      expiresAt: offer.expiresAt.toISOString(),
      score: candidate.score,
      candidates: candidates.length,
    };
  });

  return outcome;
};

/**
 * Expires one overdue offer, or reports that it was no longer expirable.
 *
 * The ride request is locked *before* the offer, in every code path that touches
 * both, so acceptance and expiry can never deadlock against each other: whoever
 * gets the request first decides the outcome, and the other one sees it.
 */
const expireOne = async (offerId, now) => {
  const existing = await prisma.dispatchOffer.findUnique({
    where: { id: offerId },
    select: { id: true, rideRequestId: true, status: true },
  });

  if (!existing) return null;

  return inTransaction(async (tx) => {
    const request = await lockRideRequest(tx, existing.rideRequestId);
    if (!request) return null;

    const offer = await tx.dispatchOffer.findUnique({
      where: { id: offerId },
      select: { id: true, status: true, expiresAt: true, driverProfileId: true },
    });

    // Re-checked under both locks: a driver may have answered between the sweep's
    // candidate query and this transaction, which is a normal outcome.
    if (!offer || offer.status !== OFFER_STATUS.PENDING) return null;
    if (!isOfferExpired(offer, now)) return null;

    await tx.dispatchOffer.update({
      where: { id: offer.id },
      data: { status: OFFER_STATUS.EXPIRED, respondedAt: now },
    });

    await appendRideEvent(tx, {
      rideRequestId: existing.rideRequestId,
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

    return { offerId: offer.id, rideRequestId: existing.rideRequestId };
  });
};

/**
 * Expires every overdue pending offer, then tries the next driver for each
 * request that lost one.
 *
 * There is no scheduler in this project, so this is the operation a scheduler
 * would call (`npm run dispatch:sweep`). `now` is injectable, which is what makes
 * expiry testable without waiting for a deadline.
 */
export const expireOverdueOffers = async ({ now = new Date(), limit = 100 } = {}) => {
  const overdue = await prisma.dispatchOffer.findMany({
    where: { status: OFFER_STATUS.PENDING, expiresAt: { lte: now } },
    select: { id: true },
    orderBy: [{ expiresAt: 'asc' }],
    take: limit,
  });

  const summary = { examined: overdue.length, expired: 0, skipped: 0, redispatched: 0 };

  for (const offer of overdue) {
    const expired = await expireOne(offer.id, now);
    if (!expired) {
      summary.skipped += 1;
      continue;
    }

    summary.expired += 1;

    // The request is waiting again, so the next best driver can be offered it.
    const result = await dispatchWaitingRequest({ rideRequestId: expired.rideRequestId, now });
    if (result.dispatched) summary.redispatched += 1;
  }

  return summary;
};

/**
 * Re-dispatches waiting requests that have no offer outstanding.
 *
 * This is the safety net for the whole design: dispatch is triggered after a
 * request is created and after every offer ends, but a process that died, a
 * transient routing failure or a run without a scheduler would leave requests
 * waiting with nobody looking at them. This sweep is the operation that makes
 * dispatch eventually correct rather than only immediately correct.
 */
export const retryWaitingRequests = async ({ now = new Date(), limit = 50 } = {}) => {
  const waiting = await prisma.rideRequest.findMany({
    where: {
      status: RIDE_REQUEST_STATUS.WAITING,
      searchExpiresAt: { gt: now },
      dispatchOffers: { none: { status: OFFER_STATUS.PENDING } },
      poolMember: null,
    },
    select: { id: true },
    orderBy: [{ requestedAt: 'asc' }],
    take: limit,
  });

  const summary = { examined: waiting.length, dispatched: 0, skipped: 0 };

  for (const request of waiting) {
    const result = await dispatchWaitingRequest({ rideRequestId: request.id, now });
    if (result.dispatched) summary.dispatched += 1;
    else summary.skipped += 1;
  }

  return summary;
};

/** The offer currently outstanding for a request, if any. Used by tests. */
export const findPendingOfferForRequest = (rideRequestId) =>
  prisma.dispatchOffer.findFirst({
    where: { rideRequestId, status: OFFER_STATUS.PENDING },
    select: { id: true, driverProfileId: true, expiresAt: true, rideRequestId: true },
  });

/** Every offer a request has ever had, oldest first. */
export const listOffersForRequest = (rideRequestId) =>
  prisma.dispatchOffer.findMany({
    where: { rideRequestId },
    orderBy: [{ offeredAt: 'asc' }],
    select: {
      id: true,
      status: true,
      driverProfileId: true,
      offeredAt: true,
      expiresAt: true,
      respondedAt: true,
      rejectionReason: true,
    },
  });
