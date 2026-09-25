import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { OFFER_STATUS, OFFER_TYPE } from './dispatch.rules.js';
import { dispatchWaitingRequest } from './dispatch.service.js';
import { createJoinOffer, findBestJoinPlan } from './matching.service.js';
import { MATCHING_RULE_VERSION } from './matching.rules.js';
import { appendRideEvent, lockRideRequest } from './ride-request.service.js';
import { RIDE_ACTOR_TYPE, RIDE_EVENT_TYPE, RIDE_REQUEST_STATUS } from './ride.status.js';

/**
 * The assignment orchestrator: one waiting request, one decision.
 *
 * ---------------------------------------------------------------------------
 * POOL FIRST, THEN A DRIVER OF YOUR OWN
 * ---------------------------------------------------------------------------
 * Every new request tries to join a ride that is already forming, because a
 * second passenger in a car that is already going that way is cheaper for
 * everybody than a second car. Only when no existing pool can take them -- because
 * there is none nearby, or none that can take them without breaking the rules
 * about waiting and detours -- does the request go to the dispatcher that finds a
 * driver and starts a new pool.
 *
 * ---------------------------------------------------------------------------
 * THE PASSENGER STAYS WAITING UNTIL A DRIVER SAYS YES
 * ---------------------------------------------------------------------------
 * Offering is not assigning. Until a driver accepts, the request is `WAITING`:
 * a pending offer changes nothing, a refusal changes nothing, and an expired offer
 * changes nothing. That is what makes the passenger's `cancellable` flag honest
 * for the whole of the matching attempt.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENT BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 * Safe to call repeatedly and concurrently:
 *
 *   * a request that is not `WAITING`, already has a pool member, or already has a
 *     pending offer of either kind is skipped, not failed;
 *   * the offer inserts are guarded by partial unique indexes (one pending offer
 *     per request, one per driver, one route change per pool), so two orchestrators
 *     racing produce one offer and one controlled skip;
 *   * the fallback is the existing initial dispatch, which is already idempotent.
 *
 * `assignmentSource` only affects whether the pool-first stage is attempted, which
 * is what lets a caller -- or a test -- ask for "just find a driver" without
 * inventing a second dispatch path.
 */

const skip = (reason, extra = {}) => ({ assigned: false, reason, ...extra });

const inTransaction = (work) =>
  prisma.$transaction(work, { timeout: env.matching.transactionTimeoutMs });

/**
 * Appends timeline events under the request's row lock.
 *
 * The lock is not decoration: event sequence numbers are per request, so two
 * writers appending at once would either collide or silently interleave. One
 * transaction per orchestration keeps the story in order.
 */
const recordEvents = async (rideRequestId, events, now) => {
  if (events.length === 0) return;

  await inTransaction(async (tx) => {
    const request = await lockRideRequest(tx, rideRequestId);
    if (!request) return;

    for (const event of events) {
      await appendRideEvent(tx, {
        rideRequestId,
        eventType: event.eventType,
        actorType: RIDE_ACTOR_TYPE.SYSTEM,
        previousStatus: request.status,
        newStatus: request.status,
        metadata: event.metadata ?? {},
        now,
      });
    }
  });
};

/** What a passenger's request needs for an assignment decision. */
const loadRequestForAssignment = (rideRequestId) =>
  prisma.rideRequest.findUnique({
    where: { id: rideRequestId },
    select: {
      id: true,
      status: true,
      requestedAt: true,
      searchExpiresAt: true,
      pickupServicePointId: true,
      dropoffServicePointId: true,
      passengerProfileId: true,
      acceptedDistanceMeters: true,
      acceptedDurationSeconds: true,
    },
  });

/**
 * Assigns a waiting request: an existing pool if one will take it, otherwise a
 * driver of its own.
 *
 * Returns a summary rather than throwing for the ordinary "nothing to do" cases,
 * because most of them are not failures -- a request that was cancelled, or that
 * already has an offer, is a normal state of the world for a sweeper to find.
 */
export const assignWaitingRequest = async ({
  rideRequestId,
  now = new Date(),
  radiusMeters,
  allowPoolJoin = true,
}) => {
  const request = await loadRequestForAssignment(rideRequestId);

  if (!request) return skip('request_not_found');
  if (request.status !== RIDE_REQUEST_STATUS.WAITING) {
    return skip('request_not_waiting', { status: request.status });
  }
  if (request.searchExpiresAt.getTime() <= now.getTime()) {
    return skip('search_window_closed');
  }

  const member = await prisma.poolMember.findUnique({
    where: { rideRequestId },
    select: { id: true, ridePoolId: true },
  });
  if (member) return skip('already_in_pool', { poolMemberId: member.id });

  // One outstanding offer, of either kind, is the whole answer. An initial offer
  // is never created while a pool is considering a join, and vice versa: the
  // partial unique indexes on the driver would refuse it anyway, and a passenger
  // waiting on two drivers at once is not a product this milestone has.
  const pendingOffer = await prisma.dispatchOffer.findFirst({
    where: { rideRequestId, status: OFFER_STATUS.PENDING },
    select: { id: true, offerType: true, ridePoolId: true, expiresAt: true },
  });
  if (pendingOffer) {
    return skip('already_offered', {
      offerId: pendingOffer.id,
      offerType: pendingOffer.offerType,
      expiresAt: pendingOffer.expiresAt.toISOString(),
    });
  }

  const waitedSeconds = Math.max(
    0,
    (now.getTime() - new Date(request.requestedAt).getTime()) / 1000,
  );
  const withinMatchingWindow = waitedSeconds <= env.matching.windowSeconds;

  if (allowPoolJoin && withinMatchingWindow) {
    const search = await findBestJoinPlan({ request, now, radiusMeters });

    // What the search found, written before the decision is made and taken, so
    // the timeline reads in the order the work happened: what was considered,
    // then what was done about it. Only recorded when there was something to
    // consider -- "0 candidates" on every request in a city with no pools is
    // noise, and the fallback event already explains that case.
    if (search.candidates.length > 0) {
      await recordEvents(
        rideRequestId,
        [
          {
            eventType: RIDE_EVENT_TYPE.POOL_CANDIDATE_EVALUATED,
            metadata: {
              ruleVersion: MATCHING_RULE_VERSION,
              candidatePools: search.candidates.length,
              evaluatedPlans: search.evaluated,
              candidates: search.candidates.slice(0, 5),
              rejections: search.rejections,
              waitedSeconds,
            },
          },
        ],
        now,
      );
    }

    if (search.plan) {
      const offer = await createJoinOffer({ request, plan: search.plan, now });

      if (offer.offered) {
        return {
          assigned: true,
          mode: 'POOL_JOIN',
          offerId: offer.offerId,
          ridePoolId: offer.ridePoolId,
          poolVersion: offer.poolVersion,
          driverProfileId: offer.driverProfileId,
          expiresAt: offer.expiresAt,
          score: offer.score,
          candidatePools: search.candidates.length,
          evaluatedPlans: search.evaluated,
        };
      }

      // The pool moved between the search and the offer -- it was joined,
      // cancelled or re-planned. That is a *stale* answer rather than a failure,
      // so the request goes on to the dispatcher instead of being told to retry.
      await recordEvents(
        rideRequestId,
        [
          {
            eventType: RIDE_EVENT_TYPE.INITIAL_DISPATCH_FALLBACK,
            metadata: {
              reason: offer.reason,
              ridePoolId: search.plan.poolId,
              candidatePools: search.candidates.length,
            },
          },
        ],
        now,
      );
    } else {
      await recordEvents(
        rideRequestId,
        [
          {
            eventType: RIDE_EVENT_TYPE.INITIAL_DISPATCH_FALLBACK,
            metadata: {
              reason:
                search.candidates.length === 0 ? 'no_candidate_pools' : 'no_feasible_plan',
              candidatePools: search.candidates.length,
              rejections: search.rejections,
            },
          },
        ],
        now,
      );
    }
  } else {
    await recordEvents(
      rideRequestId,
      [
        {
          eventType: RIDE_EVENT_TYPE.INITIAL_DISPATCH_FALLBACK,
          metadata: {
            reason: withinMatchingWindow ? 'pool_matching_not_attempted' : 'matching_window_closed',
            waitedSeconds,
            windowSeconds: env.matching.windowSeconds,
          },
        },
      ],
      now,
    );
  }

  const dispatched = await dispatchWaitingRequest({ rideRequestId, now, radiusMeters });

  return {
    assigned: dispatched.dispatched,
    mode: OFFER_TYPE.INITIAL_RIDE,
    ...dispatched,
  };
};

/**
 * Re-assigns a request after an offer ended, without a pool-first stage.
 *
 * Used nowhere in production paths -- the sweeper calls the ordinary orchestrator,
 * which excludes the pool that just refused the request and so naturally tries the
 * next one. It exists so a test, or an operator, can ask for exactly one specific
 * thing: "find this passenger a driver", with no chance of another pool joining.
 */
export const assignInitialDriverOnly = ({ rideRequestId, now = new Date(), radiusMeters }) =>
  assignWaitingRequest({ rideRequestId, now, radiusMeters, allowPoolJoin: false });

/** The offer currently outstanding for a request, whatever kind it is. */
export const findPendingOffer = (rideRequestId) =>
  prisma.dispatchOffer.findFirst({
    where: { rideRequestId, status: OFFER_STATUS.PENDING },
    select: {
      id: true,
      offerType: true,
      ridePoolId: true,
      poolVersion: true,
      driverProfileId: true,
      expiresAt: true,
      proposalSnapshot: true,
    },
  });
