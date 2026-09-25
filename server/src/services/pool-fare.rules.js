import { Prisma } from '@prisma/client';

import {
  DEFAULT_ROUNDING_SCALE,
  FareCalculationError,
  MONEY_ROUNDING_MODE,
  METRES_PER_KILOMETER,
  SECONDS_PER_MINUTE,
  readPolicy,
  requirePositiveInteger,
  roundDown,
  roundTo,
  toExactDecimal,
} from './fare.calculator.js';

/**
 * Shared-fare rules, as pure functions.
 *
 * ---------------------------------------------------------------------------
 * WHAT A SHARED FARE IS
 * ---------------------------------------------------------------------------
 * Every passenger in a pool pays for the legs of the journey they were actually
 * on board for. A leg is the travel between one stop and the next; the passengers
 * in the vehicle for that leg split what it cost, and each passenger's fare is
 * the pool's base fare plus their share of every leg they were on.
 *
 * That is the whole idea, and it produces the three properties the product
 * promises:
 *
 *   * a passenger who is alone in the car pays for the whole leg, so there is no
 *     invented discount when nobody is sharing;
 *   * a passenger who joins and shares pays for less, because somebody else pays
 *     the rest of each leg they share;
 *   * a passenger who has already been quoted is never charged more than that
 *     quote, because the solo fare is a hard cap and the fare they were last
 *     given is another one.
 *
 * ---------------------------------------------------------------------------
 * THE RULE VERSION
 * ---------------------------------------------------------------------------
 * Any change to the arithmetic below changes what passengers are charged, so it
 * must be published as a new `SHARED_FARE_RULE_VERSION` and every stored
 * calculation records the version it was made with. An old calculation is never
 * silently reinterpreted: a different version means a different answer, and the
 * rows say which one produced them.
 *
 * ---------------------------------------------------------------------------
 * MONEY IS EXACT DECIMAL, AND A LEG IS NEVER LOST
 * ---------------------------------------------------------------------------
 * This file reuses the solo calculator's decimal handling -- `Prisma.Decimal`
 * (decimal.js), a `number` refused outright, HALF_UP at the policy's rounding
 * scale -- so a shared fare and a solo fare round the same way.
 *
 * Splitting a leg is where money can leak: `10.00 / 3` is not a representable
 * amount. So the shares are computed by rounding *down* to the currency unit and
 * then handing out the remaining units, one at a time, to passengers in a stable
 * order (their member id). The shares of a leg therefore add up to exactly the
 * leg's cost -- never a unit more, never a unit less -- and each share records
 * the residual it received. The database enforces the same sum on commit.
 */

const { Decimal } = Prisma;

/** Bumped whenever the arithmetic below changes what anybody is charged. */
export const SHARED_FARE_RULE_VERSION = 'pool-leg-share-v1';

/**
 * CURRENT is what the pool owes now. SUPERSEDED is a previous answer, kept for
 * audit. FINALIZED belongs to the trip milestone that settles a completed ride:
 * nothing in this milestone writes it, and a fare here is always an estimate.
 */
export const POOL_FARE_STATUS = Object.freeze({
  CURRENT: 'CURRENT',
  SUPERSEDED: 'SUPERSEDED',
  FINALIZED: 'FINALIZED',
});

export const POOL_FARE_STATUSES = Object.freeze(Object.values(POOL_FARE_STATUS));

/** The stop actions the onboard algorithm applies, in the order it applies them. */
export const STOP_ACTION = Object.freeze({
  PICKUP: 'PICKUP',
  DROPOFF: 'DROPOFF',
});

/**
 * Why a plan cannot be priced. Each is a statement about the plan itself, not
 * about the request that asked for it, so they are reported by name and stored
 * nowhere: a calculation that cannot be made is not a fare.
 */
export const PLAN_REJECTION = Object.freeze({
  NO_STOPS: 'NO_STOPS',
  UNKNOWN_STOP_TYPE: 'UNKNOWN_STOP_TYPE',
  UNKNOWN_MEMBER: 'UNKNOWN_MEMBER',
  DUPLICATE_STOP: 'DUPLICATE_STOP',
  DROPOFF_BEFORE_PICKUP: 'DROPOFF_BEFORE_PICKUP',
  MISSING_STOP: 'MISSING_STOP',
  NON_CONTIGUOUS_SEQUENCE: 'NON_CONTIGUOUS_SEQUENCE',
  OCCUPANCY: 'OCCUPANCY',
  UNROUTABLE: 'UNROUTABLE',
  UNBALANCED_LEG: 'UNBALANCED_LEG',
});

/** A plan that cannot be priced, or a calculation that would not conserve money. */
export class PoolFareError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.name = 'PoolFareError';
    this.reason = reason;
  }
}

const reject = (reason, message) => {
  throw new PoolFareError(reason, message);
};

/**
 * One currency unit at the policy's rounding scale: 1, 0.1, 0.01, ...
 *
 * Built from a string rather than by shifting an exponent, because the one that
 * matters is exact: `0.01` is not the same number as `1e-2` evaluated in binary
 * floating point, and the residual arithmetic below depends on it being the
 * former.
 */
const currencyUnit = (scale) =>
  scale === 0 ? new Decimal(1) : new Decimal(`0.${'0'.repeat(scale - 1)}1`);

/** The floor of 1/n at the scale the database stores it with. */
export const SHARE_RATIO_SCALE = 10;
/** The scale `unrounded_amount` is stored with. */
export const UNROUNDED_SCALE = 10;

/**
 * A stable order for handing out rounding residuals.
 *
 * Sorted by id, because that is the only ordering that does not depend on the
 * order rows happened to come back in. Two passengers on the same leg always get
 * the same units, so the same plan always produces the same fares.
 */
export const stableMemberOrder = (memberIds) => [...memberIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Who is on board for each leg of a plan.
 *
 * The plan is applied in stop order, and the action at a stop is applied *before*
 * the leg that follows it:
 *
 *     for each stop i, for the leg i -> i + 1:
 *        a pickup at i puts that member on board
 *        a drop-off at i takes them off
 *        the resulting set pays for the leg
 *
 * So a passenger starts paying immediately after being collected and stops the
 * moment they are delivered -- they never pay for a leg before their pickup or
 * after their drop-off, and never for a leg they were not in the car for.
 *
 * Everything a plan must satisfy for that to mean anything is checked here, so
 * the caller cannot price a plan whose stop order and members disagree.
 */
export const onboardByLeg = ({ stops, members, capacity }) => {
  if (!Array.isArray(stops) || stops.length === 0) {
    reject(PLAN_REJECTION.NO_STOPS, 'the pool has no stops to price');
  }

  const memberIds = new Set(members.map((member) => member.id));
  if (memberIds.size !== members.length) {
    reject(PLAN_REJECTION.UNKNOWN_MEMBER, 'the same pool member appears twice');
  }

  if (!Number.isInteger(capacity) || capacity <= 0) {
    reject(PLAN_REJECTION.OCCUPANCY, `the pool capacity is not positive (${capacity})`);
  }

  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);

  ordered.forEach((stop, index) => {
    if (stop.sequence !== index + 1) {
      reject(
        PLAN_REJECTION.NON_CONTIGUOUS_SEQUENCE,
        `the stops are not numbered 1..${ordered.length} (found ${stop.sequence} at position ${index + 1})`,
      );
    }
    if (!memberIds.has(stop.poolMemberId)) {
      reject(
        PLAN_REJECTION.UNKNOWN_MEMBER,
        `stop ${stop.sequence} names pool member ${stop.poolMemberId}, which is not in this pool`,
      );
    }
    if (stop.stopType !== STOP_ACTION.PICKUP && stop.stopType !== STOP_ACTION.DROPOFF) {
      reject(
        PLAN_REJECTION.UNKNOWN_STOP_TYPE,
        `stop ${stop.sequence} has an unknown stop type "${stop.stopType}"`,
      );
    }
  });

  const state = new Map(
    members.map((member) => [member.id, { pickedUp: false, droppedOff: false }]),
  );

  const onboard = new Set();
  const legs = [];
  const timeline = [];

  // The leg that a stop opens is the leg *after* it, so the last stop opens no
  // leg -- there is nowhere left to go.
  ordered.forEach((stop, index) => {
    const memberState = state.get(stop.poolMemberId);

    if (stop.stopType === STOP_ACTION.PICKUP) {
      if (memberState.droppedOff) {
        reject(
          PLAN_REJECTION.DROPOFF_BEFORE_PICKUP,
          `pool member ${stop.poolMemberId} is collected after being delivered (stop ${stop.sequence})`,
        );
      }
      if (memberState.pickedUp) {
        reject(
          PLAN_REJECTION.DUPLICATE_STOP,
          `pool member ${stop.poolMemberId} is collected twice (stop ${stop.sequence})`,
        );
      }
      memberState.pickedUp = true;
      onboard.add(stop.poolMemberId);
    } else {
      if (!memberState.pickedUp) {
        reject(
          PLAN_REJECTION.DROPOFF_BEFORE_PICKUP,
          `pool member ${stop.poolMemberId} is delivered without being collected (stop ${stop.sequence})`,
        );
      }
      if (memberState.droppedOff) {
        reject(
          PLAN_REJECTION.DUPLICATE_STOP,
          `pool member ${stop.poolMemberId} is delivered twice (stop ${stop.sequence})`,
        );
      }
      memberState.droppedOff = true;
      onboard.delete(stop.poolMemberId);
    }

    if (onboard.size > capacity) {
      reject(
        PLAN_REJECTION.OCCUPANCY,
        `${onboard.size} passengers would be in a ${capacity}-seat vehicle after stop ${stop.sequence}`,
      );
    }

    timeline.push({ sequence: stop.sequence, stopType: stop.stopType, occupancyAfter: onboard.size });

    const next = ordered[index + 1];
    if (!next) return;

    legs.push({
      sequence: legs.length + 1,
      fromStop: stop,
      toStop: next,
      onboardMemberIds: stableMemberOrder([...onboard]),
    });
  });

  // Every member must have been both collected and delivered: a pool member
  // without both stops is a plan that cannot be priced, not a passenger who
  // travels for free.
  for (const [memberId, memberState] of state) {
    if (!memberState.pickedUp || !memberState.droppedOff) {
      const missing = !memberState.pickedUp ? 'a pickup' : 'a drop-off';
      reject(PLAN_REJECTION.MISSING_STOP, `pool member ${memberId} has no ${missing} in this plan`);
    }
  }

  if (legs.length === 0) {
    reject(PLAN_REJECTION.NO_STOPS, 'a plan needs at least two stops to have a leg');
  }

  return { legs, timeline };
};

/**
 * What one leg cost to drive, as exact money.
 *
 * The formula is the solo formula's, minus the base fare and minus everything
 * that belongs to a single journey:
 *
 *     edgeDistanceCost = edgeKilometers × perKilometerRate × edge.fareWeight   [rounded]
 *     distanceCost     = sum(edgeDistanceCost)
 *     timeCost         = legMinutes × perMinuteRate                           [rounded]
 *     preTrafficCost   = distanceCost + timeCost
 *     trafficAdjustment= preTrafficCost × (multiplier - 1)                    [rounded]
 *     totalLegCost     = preTrafficCost + trafficAdjustment
 *
 * The traffic multiplier is applied **once**, as a recorded adjustment on top of
 * the pre-traffic cost -- never to the total, and never to the distance and time
 * separately. `preTrafficCost + round(preTrafficCost × (m - 1))` is
 * `preTrafficCost × m` with one rounding instead of two, which is why the stored
 * components add up to the stored total exactly.
 *
 * The per-edge weight multiplies the distance charge only: it never reaches the
 * duration, and it never reaches the router, which chose this path on duration
 * before any of this ran.
 */
export const computeLegCost = ({ policy, edges, trafficProfile }) => {
  const priced = readPolicy(policy);
  const moneyScale = priced.roundingScale;

  if (!Array.isArray(edges) || edges.length === 0) {
    reject(PLAN_REJECTION.UNROUTABLE, 'the leg has no routed edges to price');
  }

  const trafficMultiplier =
    trafficProfile === 'RUSH_HOUR' ? priced.rushHourMultiplier : priced.normalTrafficMultiplier;

  const pricedEdges = edges.map((edge, index) => {
    const code = typeof edge.edgeCode === 'string' && edge.edgeCode !== '' ? edge.edgeCode : null;
    if (!code) reject(PLAN_REJECTION.UNROUTABLE, `leg ${index + 1} has no edge code`);

    const fareWeight = toExactDecimal(edge.fareWeight, `fare weight of edge "${code}"`);
    if (fareWeight.lte(0)) {
      reject(PLAN_REJECTION.UNROUTABLE, `edge "${code}" has a fare weight that is not positive`);
    }

    const distanceMeters = requirePositiveInteger(edge.distanceMeters, `distance of edge "${code}"`);
    const durationSeconds = requirePositiveInteger(edge.durationSeconds, `duration of edge "${code}"`);

    const kilometers = new Decimal(distanceMeters).div(METRES_PER_KILOMETER);
    const distanceCharge = roundTo(
      kilometers.times(priced.perKilometerRate).times(fareWeight),
      moneyScale,
    );

    return { ...edge, edgeCode: code, fareWeight, distanceMeters, durationSeconds, kilometers, distanceCharge };
  });

  const distanceCost = pricedEdges.reduce((total, edge) => total.plus(edge.distanceCharge), new Decimal(0));
  const distanceMeters = pricedEdges.reduce((total, edge) => total + edge.distanceMeters, 0);
  const durationSeconds = pricedEdges.reduce((total, edge) => total + edge.durationSeconds, 0);

  const timeCost = roundTo(
    new Decimal(durationSeconds).div(SECONDS_PER_MINUTE).times(priced.perMinuteRate),
    moneyScale,
  );

  const preTrafficCost = distanceCost.plus(timeCost);
  const trafficAdjustment = roundTo(preTrafficCost.times(trafficMultiplier.minus(1)), moneyScale);
  const totalLegCost = preTrafficCost.plus(trafficAdjustment);

  return {
    edges: pricedEdges,
    distanceMeters,
    durationSeconds,
    distanceCost,
    timeCost,
    preTrafficCost,
    trafficMultiplier,
    trafficAdjustment,
    totalLegCost,
  };
};

/**
 * Splits one leg's cost between the passengers on board for it.
 *
 * `totalLegCost` is divided by the number of passengers, each share is rounded
 * *down* to the currency unit, and the remaining units are handed out one each,
 * in `stableMemberOrder`, until the shares add up to the leg's cost exactly. The
 * residual each passenger received is returned with their share, so the split can
 * be explained rather than merely reproduced.
 *
 * The shares always add up: this throws rather than returning a split that lost
 * or invented a unit. Nothing is ever discarded because of division rounding.
 */
export const allocateLegShares = ({ totalLegCost, onboardMemberIds, scale }) => {
  const count = onboardMemberIds.length;
  if (count === 0) {
    reject(PLAN_REJECTION.UNBALANCED_LEG, 'a leg with nobody on board has nothing to share');
  }

  const moneyScale = scale ?? DEFAULT_ROUNDING_SCALE;
  const total = toExactDecimal(totalLegCost, 'leg cost');
  const unit = currencyUnit(moneyScale);

  // The exact quotient, at the scale the database stores it with. Everything
  // after this is derived from the *stored* value, so the residual a share
  // records is the residual the stored numbers actually have.
  const unrounded = new Decimal(total.div(count).toFixed(UNROUNDED_SCALE));

  // Every passenger's share starts as the same rounded-down quotient; the
  // residual below is what makes them differ by at most one currency unit.
  const base = roundDown(unrounded, moneyScale);
  const baseTotal = base.times(count);

  const remaining = total.minus(baseTotal);
  if (remaining.isNegative()) {
    reject(PLAN_REJECTION.UNBALANCED_LEG, 'rounding the shares down overshot the leg cost');
  }

  const units = remaining.div(unit);
  if (!units.isInteger()) {
    reject(
      PLAN_REJECTION.UNBALANCED_LEG,
      `the residual ${remaining.toString()} is not a whole number of ${unit.toString()} units`,
    );
  }

  const unitCount = units.toNumber();
  if (unitCount >= count) {
    reject(
      PLAN_REJECTION.UNBALANCED_LEG,
      `the residual is ${unitCount} units for ${count} passengers, which rounding down cannot produce`,
    );
  }

  // Deterministic on purpose: the same leg, the same passengers and the same
  // order always give the same passenger the extra unit.
  const receivers = new Set(stableMemberOrder(onboardMemberIds).slice(0, unitCount));

  const shareRatio = new Decimal(1).div(count).toFixed(SHARE_RATIO_SCALE);

  return onboardMemberIds.map((poolMemberId) => {
    const allocated = receivers.has(poolMemberId) ? base.plus(unit) : base;

    return {
      poolMemberId,
      onboardPassengerCount: count,
      shareRatio,
      unroundedAmount: unrounded,
      allocatedAmount: allocated,
      // The exact difference between what this passenger is charged and the true
      // quotient: positive when they received a residual unit, slightly negative
      // when the fraction below the currency unit was floored away.
      roundingAdjustment: allocated.minus(unrounded),
    };
  });
};
/**
 * What one passenger owes, and how their protections were applied.
 *
 *     uncappedPooledFare = baseFare + allocatedLegCost
 *     afterMinimum       = max(minimumFare, uncappedPooledFare)
 *     afterSoloCap       = min(acceptedSoloFare, afterMinimum)
 *     finalFare          = min(previousPooledFareCap ?? afterSoloCap, afterSoloCap)
 *
 * The order matters and is the product's: the **minimum fare** is what the pool
 * would like to charge, the **solo cap** is what the passenger was promised when
 * they accepted their quote, and the **no-increase cap** is what they were
 * promised the last time this pool was priced. When they disagree, the passenger
 * wins and the difference is recorded -- it is money the platform does not
 * collect, not money that disappears.
 *
 * A passenger who has just joined has no previous pooled fare, which is what
 * makes their first pooled fare a fresh calculation rather than another cap.
 */
export const computePassengerFare = ({
  policy,
  allocatedLegCost,
  acceptedSoloFare,
  previousPooledFareCap = null,
}) => {
  const priced = readPolicy(policy);
  const scale = priced.roundingScale;

  const legCost = toExactDecimal(allocatedLegCost, 'allocated leg cost');
  const soloFare = toExactDecimal(acceptedSoloFare, 'accepted solo fare');
  const previousCap =
    previousPooledFareCap === null || previousPooledFareCap === undefined
      ? null
      : toExactDecimal(previousPooledFareCap, 'previous pooled fare cap');

  if (legCost.isNegative() || soloFare.isNegative() || (previousCap && previousCap.isNegative())) {
    throw new FareCalculationError('a shared fare cannot be calculated from a negative amount');
  }

  const baseFare = priced.baseFare;
  const uncappedPooledFare = baseFare.plus(legCost);
  const afterMinimum = Decimal.max(priced.minimumFare, uncappedPooledFare);
  const afterSoloCap = Decimal.min(soloFare, afterMinimum);

  const soloCapReduction = afterMinimum.minus(afterSoloCap);
  const finalFare = previousCap === null ? afterSoloCap : Decimal.min(previousCap, afterSoloCap);
  const noIncreaseReduction = afterSoloCap.minus(finalFare);

  return {
    previousPooledFareCap: previousCap === null ? null : roundTo(previousCap, scale),
    baseFare: roundTo(baseFare, scale),
    allocatedLegCost: roundTo(legCost, scale),
    uncappedPooledFare: roundTo(uncappedPooledFare, scale),
    minimumFare: roundTo(priced.minimumFare, scale),
    minimumFareApplied: priced.minimumFare.greaterThan(uncappedPooledFare),
    soloCapApplied: soloCapReduction.greaterThan(0),
    noIncreaseCapApplied: noIncreaseReduction.greaterThan(0),
    soloCapReduction: roundTo(soloCapReduction, scale),
    noIncreaseReduction: roundTo(noIncreaseReduction, scale),
    finalFare: roundTo(finalFare, scale),
  };
};

/** Sums a list of exact amounts, starting from zero. */
export const sumAmounts = (values) =>
  values.reduce((total, value) => total.plus(toExactDecimal(value, 'amount')), new Decimal(0));

/**
 * The totals a calculation stores, derived from its legs and allocations so the
 * row can never describe a different split than the one it holds.
 */
export const totalise = ({ legs, allocations }) => {
  const variableRouteCost = sumAmounts(legs.map((leg) => leg.totalLegCost));
  const baseFare = sumAmounts(allocations.map((allocation) => allocation.baseFare));
  const uncapped = sumAmounts(allocations.map((allocation) => allocation.uncappedPooledFare));
  const finalFare = sumAmounts(allocations.map((allocation) => allocation.finalFare));
  const soloReduction = sumAmounts(allocations.map((allocation) => allocation.soloCapReduction));
  const noIncreaseReduction = sumAmounts(allocations.map((allocation) => allocation.noIncreaseReduction));

  // How much the minimum fare added on top of the pooled shares, across every
  // passenger. It is the part of a fare no passenger produced, so it is recorded
  // rather than left inside the difference between two totals -- and the caps can
  // take some of it back, which the reductions record.
  const minimumFareUplift = sumAmounts(
    allocations.map((allocation) =>
      Decimal.max(new Decimal(0), allocation.minimumFare.minus(allocation.uncappedPooledFare)),
    ),
  );

  return {
    totalVariableRouteCost: variableRouteCost,
    totalPassengerBaseFare: baseFare,
    totalUncappedPassengerFare: uncapped,
    totalMinimumFareUplift: minimumFareUplift,
    totalFinalPassengerFare: finalFare,
    totalSoloCapReduction: soloReduction,
    totalNoIncreaseReduction: noIncreaseReduction,
  };
};

/** Whether a stored calculation was made with the rules in force today. */
export const isCurrentRuleVersion = (version) => version === SHARED_FARE_RULE_VERSION;

export { DEFAULT_ROUNDING_SCALE, MONEY_ROUNDING_MODE };
