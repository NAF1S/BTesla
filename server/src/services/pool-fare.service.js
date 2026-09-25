import { Prisma } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { resolveTrafficProfile } from '../utils/time.js';
import {
  POOL_ACTOR_TYPE,
  POOL_EVENT_TYPE,
  POOL_STATUS,
  POOL_STOP_STATUS,
} from './dispatch.rules.js';
import { findEffectiveFarePolicy, loadFareWeights } from './fare.service.js';
import { formatKilometers, formatMinutes, formatMoney } from './fare.calculator.js';
import {
  POOL_FARE_STATUS,
  PoolFareError,
  SHARED_FARE_RULE_VERSION,
  allocateLegShares,
  computeLegCost,
  computePassengerFare,
  onboardByLeg,
  sumAmounts,
  totalise,
} from './pool-fare.rules.js';
import { appendPoolEvent, lockPool, lockPoolStops } from './pool.service.js';
import { appendRideEvent, lockRideRequest } from './ride-request.service.js';
import { RIDE_ACTOR_TYPE, RIDE_EVENT_TYPE } from './ride.status.js';
import { estimateRoute } from './routing.service.js';

/**
 * Shared-fare allocation: what each passenger in a pool owes, and why.
 *
 * ---------------------------------------------------------------------------
 * WHEN THIS RUNS
 * ---------------------------------------------------------------------------
 * A pool's plan is what its fares are made of, so a calculation is written
 * whenever the plan changes -- and only then:
 *
 *   * when an initial pool is created (pool version 1);
 *   * when an `ADD_PASSENGER` offer is accepted (the next version);
 *   * and, defensively, by `recalculatePoolFaresStandalone` for a pool whose
 *     calculation is missing or stale, which is what the repair command uses.
 *
 * It runs **inside the caller's transaction**, not after it. That is the whole
 * point: a plan change that cannot be priced must not be committed, so a matched
 * passenger can never exist without an allocation. If the calculation fails, the
 * member, the stops, the route, the version bump and the request's status change
 * all roll back with it.
 *
 * The cost of that guarantee is that the critical section now routes every leg of
 * the plan (a handful of short pgRouting queries). The alternative -- pricing a
 * plan that has not been written yet, or writing a plan that cannot be priced --
 * is worse than a slightly longer transaction, and the acceptance ceiling already
 * covers it.
 *
 * ---------------------------------------------------------------------------
 * VERSIONING
 * ---------------------------------------------------------------------------
 * One row per (pool version, rule version), at most one of them CURRENT. A new
 * calculation supersedes the previous one and leaves it in place, so the history
 * of what each passenger was quoted at each step stays readable -- and a
 * passenger's *previous* fare is read from that history, which is what makes
 * "adding a passenger never increases an existing passenger's fare" a stored
 * fact rather than a hope.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PRICED
 * ---------------------------------------------------------------------------
 * The passenger-carrying legs only. The driver's approach to the first pickup is
 * not a leg in this milestone, and a leg with nobody on board is recorded but
 * funds nothing: there is no passenger to charge for it, and inventing one would
 * be charging somebody for a ride they were not on.
 */

/** A fare that could not be calculated. Always the server's own data, never the caller's input. */
export const POOL_FARE_FAILURE_MESSAGE = 'Shared fare calculation failed';

const { Decimal } = Prisma;

/** The caller asked for a plan version that is no longer current. */
export const POOL_VERSION_CHANGED_MESSAGE =
  'The pool plan changed while its fares were being calculated';

/** The calculation a caller wanted to freeze moved underneath them. */
export const POOL_FARE_CHANGED_MESSAGE =
  'The shared fare changed while the trip was departing';

const fareFailure = (reason) => {
  console.error(`[pool-fare] ${reason}`);
  return new ApiError(500, POOL_FARE_FAILURE_MESSAGE);
};

/**
 * Runs a pricing step, turning a plan problem into a controlled failure.
 *
 * A `PoolFareError` is a statement about the plan -- a stop order that cannot be
 * priced, a leg that cannot be routed -- and it must abort the transaction, not
 * leave half a fare behind. An `ApiError` from the router is already a controlled
 * failure and passes through unchanged; anything else is a bug and is reported as
 * one, with the reason logged rather than returned.
 */
const guarded = async (what, work) => {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof PoolFareError) throw fareFailure(`${what}: ${err.reason} (${err.message})`);
    throw fareFailure(`${what}: ${err.message}`);
  }
};

/**
 * The plan a calculation is made from: the pool, its members (with the solo fare
 * each of them accepted) and its stops in order.
 *
 * Lock order: **the pool, then the member requests**. A recalculation reads the
 * members under the pool's row lock and only then locks their requests, because
 * every one of them may be getting an event appended below and a timeline's
 * sequence numbers are only race-free under that member's own lock. That is the
 * opposite of the order the acceptance path uses for the request it is matching,
 * and it is still safe -- which is worth spelling out, because it is the kind of
 * thing that is only obviously fine until it is not:
 *
 *   * the joining request's lock is taken *before* the pool by its own acceptance
 *     and is never taken again here, because a request being joined is not a
 *     member yet and so is not in this list;
 *   * a member request is only ever taken *after* this pool's lock, and nothing
 *     else holds a member request and then waits for a pool: a cancellation
 *     touches its own request and its offers, never the pool;
 *   * so a cycle would need the pool's lock to be waiting on something this
 *     transaction already holds, which cannot happen -- the pool is the first
 *     lock this path takes.
 */
const loadPlan = async (tx, ridePoolId) => {
  const pool = await lockPool(tx, ridePoolId);
  if (!pool) throw new ApiError(404, `Ride pool "${ridePoolId}" was not found`);

  const members = await tx.poolMember.findMany({
    where: { ridePoolId },
    orderBy: { id: 'asc' },
    select: { id: true, rideRequestId: true, status: true },
  });

  const requests = await tx.rideRequest.findMany({
    where: { id: { in: members.map((member) => member.rideRequestId) } },
    select: { id: true, status: true, acceptedFare: true, currency: true },
  });

  const requestById = new Map(requests.map((request) => [request.id, request]));

  // Each member's own request, locked: every one of them may be getting an event
  // appended below, and a timeline's sequence numbers are only race-free under
  // that member's own lock.
  for (const member of members) {
    await lockRideRequest(tx, member.rideRequestId);
  }

  const stops = await lockPoolStops(tx, ridePoolId);

  const servicePoints = await tx.servicePoint.findMany({
    where: { id: { in: [...new Set(stops.map((stop) => stop.servicePointId))] } },
    select: { id: true, code: true, active: true },
  });
  const pointById = new Map(servicePoints.map((point) => [point.id, point]));

  return { pool, members, requestById, stops, pointById };
};

/**
 * Everything a stored leg says about how it was priced.
 *
 * Money is written as decimal strings, like the solo quote's snapshots, so
 * nothing in here can be re-read through a float. The edge list is what makes the
 * leg reproducible: distance, selected duration, fare weight and the charge the
 * weight produced, in traversal order.
 */
const toLegSnapshot = ({ cost, fromStop, toStop, funded, trafficProfile, scale }) => ({
  ruleVersion: SHARED_FARE_RULE_VERSION,
  trafficProfile,
  funded,
  from: { stopId: fromStop.id, sequence: fromStop.sequence, servicePointId: fromStop.servicePointId },
  to: { stopId: toStop.id, sequence: toStop.sequence, servicePointId: toStop.servicePointId },
  distanceMeters: cost.distanceMeters,
  distanceKilometers: formatKilometers(cost.distanceMeters),
  durationSeconds: cost.durationSeconds,
  durationMinutes: formatMinutes(cost.durationSeconds),
  edges: cost.edges.map((edge) => ({
    sequence: edge.sequence,
    edgeCode: edge.edgeCode,
    direction: edge.direction,
    distanceMeters: edge.distanceMeters,
    distanceKilometers: formatKilometers(edge.distanceMeters),
    durationSeconds: edge.durationSeconds,
    fareWeight: edge.fareWeight.toFixed(3),
    distanceCharge: formatMoney(edge.distanceCharge, scale),
  })),
  components: {
    distanceCost: formatMoney(cost.distanceCost, scale),
    timeCost: formatMoney(cost.timeCost, scale),
    preTrafficCost: formatMoney(cost.preTrafficCost, scale),
    trafficMultiplier:
      cost.trafficMultiplier === null ? null : cost.trafficMultiplier.toFixed(2),
    trafficAdjustment: formatMoney(cost.trafficAdjustment, scale),
    totalLegCost: formatMoney(cost.totalLegCost, scale),
  },
});

/**
 * A leg nobody is on still happened, and still has to be reproducible.
 *
 * Its money columns are zero because there is nobody to charge for it: not the
 * platform's idea of its cost, but the amount passengers fund, which is nothing.
 * The distance, the duration and the edges are all still recorded, so what it
 * cost to drive is one multiplication away from the snapshot and the policy.
 */
const unfundedCost = (route) => ({
  edges: route.legs.map((leg) => ({
    ...leg,
    fareWeight: null,
    kilometers: new Decimal(leg.distanceMeters).div(1000),
    distanceCharge: new Decimal(0),
  })),
  distanceMeters: route.distanceMeters,
  durationSeconds: route.durationSeconds,
  distanceCost: new Decimal(0),
  timeCost: new Decimal(0),
  preTrafficCost: new Decimal(0),
  trafficMultiplier: null,
  trafficAdjustment: new Decimal(0),
  totalLegCost: new Decimal(0),
});

/** A leg between two stops at the same service point: zero metres, zero cost. */
const zeroLengthCost = (fromCode, toCode) => ({
  edges: [],
  distanceMeters: 0,
  durationSeconds: 0,
  distanceCost: new Decimal(0),
  timeCost: new Decimal(0),
  preTrafficCost: new Decimal(0),
  trafficMultiplier: null,
  trafficAdjustment: new Decimal(0),
  totalLegCost: new Decimal(0),
  fromCode,
  toCode,
});

/**
 * Routes and prices every leg of a plan, in stop order.
 *
 * The traffic profile is resolved from the calculation instant with the same rule
 * the router uses, and passed to the router as the departure instant, so the
 * duration a leg is charged for and the multiplier it is charged under are the
 * same traffic regime. Whatever the profile is, the multiplier reaches the leg
 * cost exactly once.
 */
const priceLegs = async ({ legs, pointById, policy, trafficProfile, now }) => {
  const priced = [];

  for (const leg of legs) {
    const fromPoint = pointById.get(leg.fromStop.servicePointId);
    const toPoint = pointById.get(leg.toStop.servicePointId);

    if (!fromPoint || !toPoint) {
      throw new ApiError(409, 'A stop in this pool no longer names a service point');
    }

    const funded = leg.onboardMemberIds.length > 0;

    // Two passengers collected at the same stop are two stops and a leg of zero
    // length between them. The router refuses an identical origin and
    // destination (correctly: there is no journey), so this leg is priced here by
    // definition rather than asked about: nothing was driven, so nothing is owed.
    if (fromPoint.code === toPoint.code) {
      const cost = zeroLengthCost(fromPoint.code, toPoint.code);

      priced.push({
        leg,
        onboardMemberIds: leg.onboardMemberIds,
        cost,
        routeSnapshot: toLegSnapshot({
          cost,
          fromStop: leg.fromStop,
          toStop: leg.toStop,
          funded,
          trafficProfile,
          scale: policy.roundingScale,
        }),
      });
      continue;
    }

    const route = await estimateRoute({
      originServicePointCode: fromPoint.code,
      destinationServicePointCode: toPoint.code,
      departureAt: now,
    });

    if (!funded) {
      // The driver drove it and nobody was in the car: recorded for audit, worth
      // nothing to any passenger.
      const cost = unfundedCost(route);

      priced.push({
        leg,
        onboardMemberIds: [],
        cost,
        routeSnapshot: toLegSnapshot({
          cost,
          fromStop: leg.fromStop,
          toStop: leg.toStop,
          funded: false,
          trafficProfile: route.trafficProfile,
          scale: policy.roundingScale,
        }),
      });
      continue;
    }

    const weights = await loadFareWeights(route.legs.map((routeLeg) => routeLeg.edgeCode));
    const edges = route.legs.map((routeLeg) => ({
      ...routeLeg,
      fareWeight: weights.get(routeLeg.edgeCode),
    }));

    const cost = computeLegCost({ policy, edges, trafficProfile: route.trafficProfile });

    priced.push({
      leg,
      onboardMemberIds: leg.onboardMemberIds,
      cost,
      routeSnapshot: toLegSnapshot({
        cost,
        fromStop: leg.fromStop,
        toStop: leg.toStop,
        funded: true,
        trafficProfile: route.trafficProfile,
        scale: policy.roundingScale,
      }),
    });
  }

  return priced;
};

/**
 * The fare calculation for a pool version, written inside the caller's
 * transaction.
 *
 * Idempotent: if this pool version has already been calculated under the current
 * rule version, the stored calculation is returned and nothing is written. That
 * is what makes a retry, or a sweep racing an acceptance, produce one answer
 * rather than two.
 *
 * The caller must supply `expectedPoolVersion` -- the plan version the change it
 * just made produced. A mismatch is a conflict, never a recalculation of a plan
 * that is no longer there.
 */
export const recalculatePoolFares = async ({
  tx,
  ridePoolId,
  expectedPoolVersion,
  now = new Date(),
  actorUserId = null,
}) => {
  if (!Number.isInteger(expectedPoolVersion) || expectedPoolVersion <= 0) {
    throw new ApiError(500, 'A pool fare calculation needs the plan version it describes');
  }

  const { pool, members, requestById, stops, pointById } = await loadPlan(tx, ridePoolId);

  if (pool.version !== expectedPoolVersion) {
    throw new ApiError(409, POOL_VERSION_CHANGED_MESSAGE);
  }

  if (pool.status !== POOL_STATUS.FORMING) {
    throw new ApiError(
      409,
      `A shared fare can only be calculated for a forming pool (this one is ${pool.status.toLowerCase()})`,
    );
  }

  if (stops.length < 2) {
    throw new ApiError(409, 'A pool needs at least a pickup and a drop-off before it can be priced');
  }

  if (stops.some((stop) => stop.status !== POOL_STOP_STATUS.PENDING)) {
    // A stop that has been reached means the trip has started, and this
    // milestone prices plans, not trips. The trip milestone will need its own
    // rule version rather than a silent change to this one.
    throw new ApiError(409, 'A shared fare can only be calculated while every stop is still pending');
  }

  const existing = await tx.poolFareCalculation.findFirst({
    where: {
      ridePoolId,
      poolVersion: expectedPoolVersion,
      sharedFareRuleVersion: SHARED_FARE_RULE_VERSION,
    },
    select: { id: true, status: true, poolVersion: true },
  });

  if (existing) {
    return {
      calculationId: existing.id,
      poolVersion: existing.poolVersion,
      status: 'existing',
      supersededCalculationId: null,
    };
  }

  if (members.length === 0) {
    throw new ApiError(409, 'A pool with no members has nothing to charge for');
  }

  for (const member of members) {
    if (!requestById.has(member.rideRequestId)) {
      throw new ApiError(500, `Pool member ${member.id} names a ride request that was not found`);
    }
  }

  // 1. Who is on board for which leg, and whether the plan is priceable at all.
  const onboard = await guarded('reading the pool plan', async () =>
    onboardByLeg({
      stops,
      members,
      capacity: pool.capacitySnapshot,
    }),
  );

  const policy = await guarded('loading the fare policy', () =>
    findEffectiveFarePolicy(now),
  );

  const trafficProfile = resolveTrafficProfile(now, env.routing.rushHourWindows);

  // 2. What each leg cost to drive.
  const pricedLegs = await guarded('routing the legs of the plan', () =>
    priceLegs({ legs: onboard.legs, pointById, policy, trafficProfile, now }),
  );

  // 3. The previous answer, which is what caps each existing passenger's fare.
  const previous = await tx.poolFareCalculation.findFirst({
    where: { ridePoolId, poolVersion: { lt: expectedPoolVersion } },
    orderBy: [{ poolVersion: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      poolVersion: true,
      status: true,
      allocations: { select: { poolMemberId: true, finalFare: true } },
    },
  });

  const previousCapByMember = new Map(
    (previous?.allocations ?? []).map((allocation) => [
      allocation.poolMemberId,
      allocation.finalFare,
    ]),
  );

  // 4. What each passenger owes.
  //
  // Each leg is split once, so every passenger's share of it comes from the same
  // division and the same residual assignment -- a passenger cannot be allocated
  // a share the leg's own split did not produce.
  const sharesByLeg = pricedLegs.map((pricedLeg) => ({
    pricedLeg,
    shares: pricedLeg.onboardMemberIds.length === 0
      ? []
      : allocateLegShares({
          totalLegCost: pricedLeg.cost.totalLegCost,
          onboardMemberIds: pricedLeg.onboardMemberIds,
          scale: policy.roundingScale,
        }),
  }));

  const allocations = members.map((member) => {
    const request = requestById.get(member.rideRequestId);

    const sharesForMember = sharesByLeg
      .map(({ pricedLeg, shares }) => ({
        pricedLeg,
        share: shares.find((share) => share.poolMemberId === member.id),
      }))
      .filter(({ share }) => share !== undefined);

    const allocatedLegCost = sumAmounts(sharesForMember.map(({ share }) => share.allocatedAmount));

    const fare = computePassengerFare({
      policy,
      allocatedLegCost,
      acceptedSoloFare: request.acceptedFare,
      previousPooledFareCap: previousCapByMember.get(member.id) ?? null,
    });

    return { member, request, fare, shares: sharesForMember };
  });

  // The shares of a leg must add up to the leg's cost. The database proves this
  // again on commit; checking here means a broken split rolls back with a useful
  // message instead of a constraint violation.
  for (const { pricedLeg, shares } of sharesByLeg) {
    const allocated = sumAmounts(shares.map((share) => share.allocatedAmount));

    if (!allocated.equals(pricedLeg.cost.totalLegCost)) {
      throw fareFailure(
        `leg ${pricedLeg.leg.sequence} allocates ${allocated.toString()} but costs ${pricedLeg.cost.totalLegCost.toString()}`,
      );
    }
  }

  const totals = totalise({
    legs: pricedLegs.map(({ cost }) => ({ totalLegCost: cost.totalLegCost })),
    allocations: allocations.map(({ fare }) => fare),
  });

  const routeDistanceMeters = pricedLegs.reduce((total, { cost }) => total + cost.distanceMeters, 0);
  const routeDurationSeconds = pricedLegs.reduce((total, { cost }) => total + cost.durationSeconds, 0);

  // 5. Supersede the previous answer *before* inserting the new one: the partial
  // unique index allows one CURRENT calculation per pool, so the old one has to
  // give way first.
  let supersededCalculationId = null;

  if (previous && previous.status === POOL_FARE_STATUS.CURRENT) {
    const superseded = await tx.poolFareCalculation.updateMany({
      where: { id: previous.id, status: POOL_FARE_STATUS.CURRENT },
      data: { status: POOL_FARE_STATUS.SUPERSEDED },
    });

    if (superseded.count !== 1) {
      throw new ApiError(409, POOL_VERSION_CHANGED_MESSAGE);
    }

    supersededCalculationId = previous.id;

    await appendPoolEvent(tx, {
      ridePoolId,
      eventType: POOL_EVENT_TYPE.SHARED_FARE_SUPERSEDED,
      actorType: POOL_ACTOR_TYPE.SYSTEM,
      metadata: {
        fareCalculationId: previous.id,
        poolVersion: previous.poolVersion,
        sharedFareRuleVersion: SHARED_FARE_RULE_VERSION,
        reason: 'pool_plan_changed',
      },
      now,
    });
  }

  // 6. The new answer.
  const calculation = await tx.poolFareCalculation.create({
    data: {
      ridePoolId,
      poolVersion: expectedPoolVersion,
      pricingPolicyId: policy.id,
      pricingCode: policy.code,
      pricingVersion: policy.version,
      sharedFareRuleVersion: SHARED_FARE_RULE_VERSION,
      status: POOL_FARE_STATUS.CURRENT,
      currency: policy.currency,
      trafficProfile,
      routeDistanceMeters,
      routeDurationSeconds,
      totalVariableRouteCost: totals.totalVariableRouteCost,
      totalPassengerBaseFare: totals.totalPassengerBaseFare,
      totalUncappedPassengerFare: totals.totalUncappedPassengerFare,
      totalMinimumFareUplift: totals.totalMinimumFareUplift,
      totalFinalPassengerFare: totals.totalFinalPassengerFare,
      totalSoloCapReduction: totals.totalSoloCapReduction,
      totalNoIncreaseReduction: totals.totalNoIncreaseReduction,
      createdAt: now,
    },
    select: { id: true },
  });

  const legIdBySequence = new Map();

  for (const pricedLeg of pricedLegs) {
    const leg = await tx.poolFareLeg.create({
      data: {
        fareCalculationId: calculation.id,
        sequence: pricedLeg.leg.sequence,
        fromPoolStopId: pricedLeg.leg.fromStop.id,
        toPoolStopId: pricedLeg.leg.toStop.id,
        distanceMeters: pricedLeg.cost.distanceMeters,
        durationSeconds: pricedLeg.cost.durationSeconds,
        distanceCost: pricedLeg.cost.distanceCost ?? 0,
        timeCost: pricedLeg.cost.timeCost ?? 0,
        trafficAdjustment: pricedLeg.cost.trafficAdjustment ?? 0,
        totalLegCost: pricedLeg.cost.totalLegCost,
        onboardPassengerCount: pricedLeg.onboardMemberIds.length,
        routeSnapshot: pricedLeg.routeSnapshot,
      },
      select: { id: true },
    });

    legIdBySequence.set(pricedLeg.leg.sequence, leg.id);
  }

  for (const allocation of allocations) {
    const created = await tx.passengerFareAllocation.create({
      data: {
        fareCalculationId: calculation.id,
        poolMemberId: allocation.member.id,
        rideRequestId: allocation.member.rideRequestId,
        acceptedSoloFare: allocation.request.acceptedFare,
        previousPooledFareCap: allocation.fare.previousPooledFareCap,
        baseFare: allocation.fare.baseFare,
        allocatedLegCost: allocation.fare.allocatedLegCost,
        uncappedPooledFare: allocation.fare.uncappedPooledFare,
        minimumFare: allocation.fare.minimumFare,
        minimumFareApplied: allocation.fare.minimumFareApplied,
        soloCapApplied: allocation.fare.soloCapApplied,
        noIncreaseCapApplied: allocation.fare.noIncreaseCapApplied,
        soloCapReduction: allocation.fare.soloCapReduction,
        noIncreaseReduction: allocation.fare.noIncreaseReduction,
        finalFare: allocation.fare.finalFare,
        currency: policy.currency,
        createdAt: now,
      },
      select: { id: true },
    });

    for (const { pricedLeg, share } of allocation.shares) {
      await tx.passengerFareLegShare.create({
        data: {
          passengerFareAllocationId: created.id,
          poolFareLegId: legIdBySequence.get(pricedLeg.leg.sequence),
          onboardPassengerCount: share.onboardPassengerCount,
          shareRatio: share.shareRatio,
          unroundedAmount: share.unroundedAmount,
          allocatedAmount: share.allocatedAmount,
          roundingAdjustment: share.roundingAdjustment,
          createdAt: now,
        },
      });
    }
  }

  // 7. The events. The pool's history explains the calculation; each passenger's
  // own timeline explains *their* fare, and never anybody else's.
  await appendPoolEvent(tx, {
    ridePoolId,
    eventType: POOL_EVENT_TYPE.SHARED_FARE_CALCULATED,
    actorType: POOL_ACTOR_TYPE.SYSTEM,
    actorUserId,
    metadata: {
      fareCalculationId: calculation.id,
      poolVersion: expectedPoolVersion,
      sharedFareRuleVersion: SHARED_FARE_RULE_VERSION,
      pricingCode: policy.code,
      pricingVersion: policy.version,
      trafficProfile,
      legCount: pricedLegs.length,
      fundedLegCount: pricedLegs.filter((pricedLeg) => pricedLeg.onboardMemberIds.length > 0).length,
      routeDistanceMeters,
      routeDurationSeconds,
      totalVariableRouteCost: formatMoney(totals.totalVariableRouteCost, policy.roundingScale),
      totalMinimumFareUplift: formatMoney(totals.totalMinimumFareUplift, policy.roundingScale),
      totalFinalPassengerFare: formatMoney(totals.totalFinalPassengerFare, policy.roundingScale),
      totalSoloCapReduction: formatMoney(totals.totalSoloCapReduction, policy.roundingScale),
      totalNoIncreaseReduction: formatMoney(totals.totalNoIncreaseReduction, policy.roundingScale),
      passengerCount: allocations.length,
    },
    now,
  });

  for (const allocation of allocations) {
    const totalReduction = allocation.fare.soloCapReduction.plus(allocation.fare.noIncreaseReduction);

    await appendRideEvent(tx, {
      rideRequestId: allocation.member.rideRequestId,
      eventType: RIDE_EVENT_TYPE.PASSENGER_FARE_ALLOCATED,
      actorType: RIDE_ACTOR_TYPE.SYSTEM,
      previousStatus: allocation.request.status,
      newStatus: allocation.request.status,
      metadata: {
        fareCalculationId: calculation.id,
        poolVersion: expectedPoolVersion,
        sharedFareRuleVersion: SHARED_FARE_RULE_VERSION,
        pricingCode: policy.code,
        pricingVersion: policy.version,
        acceptedSoloFare: formatMoney(allocation.request.acceptedFare, policy.roundingScale),
        previousPooledFare:
          allocation.fare.previousPooledFareCap === null
            ? null
            : formatMoney(allocation.fare.previousPooledFareCap, policy.roundingScale),
        allocatedLegCost: formatMoney(allocation.fare.allocatedLegCost, policy.roundingScale),
        baseFare: formatMoney(allocation.fare.baseFare, policy.roundingScale),
        finalFare: formatMoney(allocation.fare.finalFare, policy.roundingScale),
        currency: policy.currency,
        legsPaidFor: allocation.shares.length,
      },
      now,
    });

    if (totalReduction.greaterThan(0)) {
      await appendRideEvent(tx, {
        rideRequestId: allocation.member.rideRequestId,
        eventType: RIDE_EVENT_TYPE.PASSENGER_FARE_REDUCED,
        actorType: RIDE_ACTOR_TYPE.SYSTEM,
        previousStatus: allocation.request.status,
        newStatus: allocation.request.status,
        metadata: {
          fareCalculationId: calculation.id,
          poolVersion: expectedPoolVersion,
          soloCapReduction: formatMoney(allocation.fare.soloCapReduction, policy.roundingScale),
          noIncreaseReduction: formatMoney(allocation.fare.noIncreaseReduction, policy.roundingScale),
          totalReduction: formatMoney(totalReduction, policy.roundingScale),
          singleFareCapApplied: allocation.fare.soloCapApplied,
          noIncreaseCapApplied: allocation.fare.noIncreaseCapApplied,
          minimumFareApplied: allocation.fare.minimumFareApplied,
          currency: policy.currency,
        },
        now,
      });
    }
  }

  return {
    calculationId: calculation.id,
    poolVersion: expectedPoolVersion,
    status: 'created',
    supersededCalculationId,
    totals,
    legs: pricedLegs.length,
    passengers: allocations.length,
  };
};

/**
 * Freezes the pool's current calculation: the fare the trip runs under.
 *
 * Called inside the departure transaction, so a trip cannot begin until its
 * fare is settled for the plan that was actually accepted -- and, from that
 * moment, nothing can re-price it: a recalculation needs a FORMING pool, and a
 * pool that has departed is not one.
 *
 * Idempotent by state, like every trip command: a second call for a pool whose
 * fare is already frozen reports it as already frozen rather than failing or
 * writing a second time. The amounts and versions are immutable by trigger, and
 * the only move allowed is CURRENT -> FINALIZED, so a retry cannot corrupt a
 * frozen fare even if it tried.
 *
 * The caller must already hold the pool's row lock, which is what makes the
 * read-then-write here safe without a lock of its own.
 */
export const finalizePoolFareCalculation = async ({ tx, ridePoolId, now = new Date() }) => {
  const current = await tx.poolFareCalculation.findFirst({
    where: { ridePoolId, status: POOL_FARE_STATUS.CURRENT },
    select: { id: true, poolVersion: true },
  });

  if (current) {
    const finalized = await tx.poolFareCalculation.updateMany({
      where: { id: current.id, status: POOL_FARE_STATUS.CURRENT },
      data: { status: POOL_FARE_STATUS.FINALIZED, finalizedAt: now },
    });

    if (finalized.count !== 1) throw new ApiError(409, POOL_FARE_CHANGED_MESSAGE);

    return {
      status: 'finalized',
      calculationId: current.id,
      poolVersion: current.poolVersion,
      finalizedAt: now,
    };
  }

  const already = await tx.poolFareCalculation.findFirst({
    where: { ridePoolId, status: POOL_FARE_STATUS.FINALIZED },
    orderBy: { poolVersion: 'desc' },
    select: { id: true, poolVersion: true, finalizedAt: true },
  });

  if (already) {
    return {
      status: 'already-finalized',
      calculationId: already.id,
      poolVersion: already.poolVersion,
      finalizedAt: already.finalizedAt,
    };
  }

  throw new ApiError(409, 'This pool has no shared fare to settle');
};

/**
 * Recalculates one pool's fares in their own transaction.
 *
 * The entry point for the repair command and for tests. It is idempotent, so
 * running it twice for the same pool version writes one calculation, and it
 * refuses a stale `expectedPoolVersion` rather than pricing a plan that has
 * moved on.
 */
export const recalculatePoolFaresStandalone = async ({
  ridePoolId,
  expectedPoolVersion,
  now = new Date(),
}) =>
  prisma.$transaction(
    (tx) =>
      recalculatePoolFares({
        tx,
        ridePoolId,
        expectedPoolVersion,
        now,
      }),
    { timeout: env.fare.pool.transactionTimeoutMs },
  );

/**
 * The fare a passenger is currently being charged for one ride request, with the
 * calculation it belongs to.
 *
 * A `FINALIZED` calculation is the one a departed trip is running under, so it is
 * still this passenger's fare: the answer does not disappear when the trip
 * starts. `CURRENT` is preferred while it exists, because a pool still being
 * planned is the only case where both can be interesting.
 *
 * Returns null when the request has no pool member yet, or its pool has no
 * calculation at all: a passenger who has not been matched has no shared fare,
 * and a client should be told that rather than shown zero.
 */
export const loadCurrentFareForRequest = async ({ rideRequestId }) => {
  const member = await prisma.poolMember.findUnique({
    where: { rideRequestId },
    select: { id: true, ridePoolId: true },
  });

  if (!member) return null;

  const calculationSelect = {
    id: true,
    poolVersion: true,
    status: true,
    currency: true,
    pricingCode: true,
    pricingVersion: true,
    sharedFareRuleVersion: true,
    createdAt: true,
    finalizedAt: true,
    pricingPolicy: { select: { roundingScale: true } },
  };

  // The current answer first; a frozen one is the answer a departed trip ran
  // under, which is still this passenger's fare. Asking in that order rather than
  // ordering by status keeps the meaning in the code instead of in the enum's
  // declaration order.
  const calculation =
    (await prisma.poolFareCalculation.findFirst({
      where: { ridePoolId: member.ridePoolId, status: POOL_FARE_STATUS.CURRENT },
      select: calculationSelect,
    })) ??
    (await prisma.poolFareCalculation.findFirst({
      where: { ridePoolId: member.ridePoolId, status: POOL_FARE_STATUS.FINALIZED },
      orderBy: { poolVersion: 'desc' },
      select: calculationSelect,
    }));

  if (!calculation) return null;

  const allocation = await prisma.passengerFareAllocation.findUnique({
    where: {
      fareCalculationId_poolMemberId: {
        fareCalculationId: calculation.id,
        poolMemberId: member.id,
      },
    },
    select: {
      acceptedSoloFare: true,
      previousPooledFareCap: true,
      baseFare: true,
      allocatedLegCost: true,
      uncappedPooledFare: true,
      minimumFare: true,
      minimumFareApplied: true,
      soloCapApplied: true,
      noIncreaseCapApplied: true,
      soloCapReduction: true,
      noIncreaseReduction: true,
      finalFare: true,
      createdAt: true,
      shares: { select: { poolFareLegId: true } },
    },
  });

  if (!allocation) return null;

  return {
    ridePoolId: member.ridePoolId,
    poolMemberId: member.id,
    calculation,
    allocation,
    legsPaidFor: allocation.shares.length,
    roundingScale: calculation.pricingPolicy.roundingScale,
  };
};

/** A plan that cannot be priced, reported by name. Exported for tests and callers. */
export { PoolFareError };
