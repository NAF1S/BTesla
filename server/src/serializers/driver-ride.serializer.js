import { chargeScale, formatMoney } from '../services/fare.calculator.js';
import { allowedActions, nextActionableStop, orderedStops } from '../services/trip.rules.js';
import { TIMELINE_AUDIENCE, toTimeline } from '../services/timeline.rules.js';

/**
 * The driver's own ride history, as the driver's client sees it.
 *
 * ---------------------------------------------------------------------------
 * WHAT A DRIVER MAY SEE
 * ---------------------------------------------------------------------------
 * A driver has to operate the ride they are assigned: who they are collecting,
 * from where, in what order, and when each of those things happened. So a member
 * appears with a display name, their two service points and their own timestamps
 * -- and nothing else. The following are never selected, so they cannot appear:
 *
 *   * the passenger's user id, account fields, email or any other credential;
 *   * the passenger's ride-request `acceptedFare` or any per-passenger fare. The
 *     pool's own total is reported once, as a number, with no way to attribute it
 *     to the person sitting in the car;
 *   * any passenger's event history. `ride_events` is the passenger's own record
 *     and is not read here at all -- the driver gets the *pool's* timeline;
 *   * any other driver's anything. The pool is reached through the authenticated
 *     driver's own rows.
 *
 * ---------------------------------------------------------------------------
 * MONEY IN A HISTORY, NOT MID-TRIP
 * ---------------------------------------------------------------------------
 * A finished pool reports its fare total. The pool a driver is *currently*
 * driving does not -- `pool.serializer.js` reports only whether the fare is
 * settled. That asymmetry is deliberate: while a driver can still decide where to
 * go next, what a passenger is paying must not be part of that decision.
 *
 * ---------------------------------------------------------------------------
 * A SUMMARY IS NOT A DETAIL
 * ---------------------------------------------------------------------------
 * The list is built without reading any member rows (a count is enough) and
 * without the event log. That keeps a history page to a fixed, small number of
 * queries, and it keeps a driver from being able to page back through every
 * passenger they have ever carried in one request.
 */

const toIsoString = (value) => (value ? new Date(value).toISOString() : null);

const toServicePoint = (point) => (point ? { code: point.code, name: point.name } : null);

/** A passenger as a driver may know them: a first name, and their own two places. */
const toMemberDto = (member) => {
  const request = member.rideRequest;
  const name = request?.passengerProfile?.user?.name ?? null;

  return {
    memberId: member.id,
    memberStatus: member.status,
    displayName: name ? name.split(/\s+/)[0] : null,
    pickup: toServicePoint(request?.pickupServicePoint),
    dropoff: toServicePoint(request?.dropoffServicePoint),
    matchedAt: toIsoString(member.matchedAt),
    pickedUpAt: toIsoString(member.pickedUpAt),
    droppedOffAt: toIsoString(member.droppedOffAt),
  };
};

const toStopDto = (stop) => ({
  stopId: stop.id,
  sequence: stop.sequence,
  stopType: stop.stopType,
  status: stop.status,
  servicePoint: toServicePoint(stop.servicePoint),
  poolMemberId: stop.poolMemberId ?? null,
  plannedArrivalAt: toIsoString(stop.plannedArrivalAt),
  actualArrivalAt: toIsoString(stop.actualArrivalAt),
  completedAt: toIsoString(stop.completedAt),
});

/**
 * The pool's fare, as a history reports it.
 *
 * `totalPassengerFare` is the whole pool; there is deliberately no per-passenger
 * breakdown, because attributing an amount to a named person would disclose what
 * that passenger was charged.
 */
const toFareSummary = (calculation) => {
  if (!calculation?.pricingPolicy) return null;

  const scale = calculation.pricingPolicy.roundingScale;

  return {
    fareStatus: calculation.status === 'FINALIZED' ? 'FINALIZED' : 'ESTIMATED',
    finalized: calculation.status === 'FINALIZED',
    finalizedAt: toIsoString(calculation.finalizedAt),
    currency: calculation.currency,
    poolVersion: calculation.poolVersion,
    totalPassengerFare: formatMoney(
      calculation.totalFinalPassengerFare,
      chargeScale(calculation.totalFinalPassengerFare, scale),
    ),
  };
};

/**
 * One row of the driver's history.
 *
 * `firstServicePoint` and `finalServicePoint` are the first and last stops of the
 * plan, which is what "where did this trip run" means: the driver's approach to
 * the first pickup is not a stop and is not part of the plan.
 *
 * `completedStops` and `passengerCount` are counts, not rows: a driver scanning
 * their history wants "3 of 4 stops, 2 passengers", not the details of people
 * they carried last month.
 */
export const toDriverRideSummaryDto = ({ pool, firstStop, finalStop, completedStops }) => {
  const first = firstStop ?? null;
  const last = finalStop ?? null;

  return {
    poolId: pool.id,
    status: pool.status,
    vehicle: pool.vehicle
      ? { vehicleId: pool.vehicle.id, name: pool.vehicle.name, seatCapacity: pool.vehicle.seatCapacity }
      : null,

    // Newest-first lists are ordered by `createdAt`; `acceptedAt` is when the
    // driver took the job, which is the instant the trip started running.
    createdAt: toIsoString(pool.createdAt),
    acceptedAt: toIsoString(pool.acceptedAt),
    completedAt: toIsoString(pool.completedAt),

    firstServicePoint: toServicePoint(first?.servicePoint),
    finalServicePoint: toServicePoint(last?.servicePoint),

    route: {
      distanceMeters: Number(pool.plannedDistanceMeters),
      durationSeconds: pool.plannedDurationSeconds,
    },

    passengerCount: pool._count?.members ?? 0,
    stopCount: pool._count?.stops ?? 0,
    completedStopCount: completedStops,

    fare: toFareSummary(pool.fareCalculations?.[0]),
  };
};

export const toDriverRideHistoryDto = ({ rides, total, limit, offset }) => ({
  data: rides.map(toDriverRideSummaryDto),
  pagination: {
    limit,
    offset,
    returned: rides.length,
    total,
    hasMore: offset + rides.length < total,
  },
});

/**
 * One pool in detail.
 *
 * Adds the ordered plan, the passengers, the pool's own timeline, and what the
 * driver may do next if the trip is still running.
 *
 * `allowedActions` is the same server-computed list the current-pool endpoint
 * publishes, and it is included here for the same reason: a client never decides
 * which transition is legal. On a finished pool it is empty, so a history detail
 * and a live pool answer with one shape.
 */
export const toDriverRideDetailDto = ({ pool, events }) => {
  const stops = orderedStops(pool.stops).map(toStopDto);
  const next = nextActionableStop(stops);

  return {
    poolId: pool.id,
    status: pool.status,
    version: pool.version,
    capacity: pool.capacitySnapshot,
    vehicle: pool.vehicle
      ? { vehicleId: pool.vehicle.id, name: pool.vehicle.name, seatCapacity: pool.vehicle.seatCapacity }
      : null,

    createdAt: toIsoString(pool.createdAt),
    acceptedAt: toIsoString(pool.acceptedAt),
    departedAt: toIsoString(pool.departedAt),
    driverArrivedAt: toIsoString(pool.driverArrivedAt),
    startedAt: toIsoString(pool.startedAt),
    completedAt: toIsoString(pool.completedAt),
    cancelledAt: toIsoString(pool.cancelledAt),

    route: {
      distanceMeters: Number(pool.plannedDistanceMeters),
      durationSeconds: pool.plannedDurationSeconds,
    },

    stops,
    nextStop: next ? toStopDto(next) : null,
    passengers: (pool.members ?? []).map(toMemberDto),
    passengerCount: pool._count?.members ?? (pool.members ?? []).length,

    fare: toFareSummary(pool.fareCalculations?.[0]),

    // Whether the trip is still live, and the one thing the driver may do next.
    // Derived from the state, never stored, so a history detail cannot offer a
    // command the trip endpoint would refuse.
    allowedActions: allowedActions({
      pool: { status: pool.status },
      stops,
      members: (pool.members ?? []).map((member) => ({
        id: member.id,
        status: member.status,
        rideRequestId: member.rideRequest?.id ?? null,
        requestStatus: member.rideRequest?.status ?? null,
      })),
      fare: pool.fareCalculations?.[0]
        ? {
            id: pool.fareCalculations[0].id,
            status: pool.fareCalculations[0].status,
            poolVersion: pool.fareCalculations[0].poolVersion,
            finalizedAt: pool.fareCalculations[0].finalizedAt,
          }
        : null,
    }),

    timeline: toTimeline(events, TIMELINE_AUDIENCE.DRIVER),
  };
};
