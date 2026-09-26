import { chargeScale, formatMoney } from '../services/fare.calculator.js';
import { isCancellable } from '../services/ride.status.js';
import { passengerNextAction, passengerTripStage } from '../services/trip.rules.js';
import { TIMELINE_AUDIENCE, toTimeline } from '../services/timeline.rules.js';
import { quoteRoundingScale } from './fare.serializer.js';

/**
 * The passenger's own ride history, as the passenger's client sees it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE, AND WHY
 * ---------------------------------------------------------------------------
 * Every DTO in this file is built from one `RideRequest` (and, when matched, that
 * request's own `PoolMember`). The pool is reached *through* the member, never the
 * other way round, which is what makes the privacy guarantee structural rather
 * than a filter somebody has to remember to apply:
 *
 *   * no other passenger's name, account id or contact details -- their rows are
 *     not selected;
 *   * no other passenger's ride-request id -- not selected;
 *   * no other passenger's pickup or destination -- not selected;
 *   * no other passenger's fare -- the fare read is keyed by *this* request;
 *   * no other passenger's event history -- `ride_events` is per request.
 *
 * What *is* shared is aggregate: `passengerCount` says how many people are in the
 * car, and `vehicle.seatCapacity` how many it holds. A count cannot be unpacked
 * into a person, and a passenger has a legitimate interest in both.
 *
 * ---------------------------------------------------------------------------
 * PRESENTATION FIELDS
 * ---------------------------------------------------------------------------
 * `stage` and `nextAction` are computed here from the request's own facts rather
 * than stored, so they cannot disagree with the timestamps that justify them. The
 * rules live in `trip.rules.js`; this file only chooses how to name them.
 */

const toIsoString = (value) => (value ? new Date(value).toISOString() : null);

const toServicePoint = (point) => (point ? { code: point.code, name: point.name } : null);

/** A driver as a passenger may know them: a first name, and nothing else. */
const toDriverSummary = (pool) => {
  const name = pool?.driverProfile?.user?.name ?? null;

  return name ? { displayName: name.split(/\s+/)[0] } : null;
};

const toVehicleSummary = (pool) =>
  pool?.vehicle ? { name: pool.vehicle.name, seatCapacity: pool.vehicle.seatCapacity } : null;

/**
 * The passenger's own shared fare, condensed for a list row.
 *
 * Deliberately not the full breakdown -- `GET /ride-requests/:id/fare` and the
 * detail endpoint below own that. A history row needs "what did this cost me, and
 * is that number final", which is two values.
 *
 * `finalized` is read from the calculation's status, so a passenger can tell a
 * fare they travelled under (frozen at departure) from an estimate for a ride
 * that has not started.
 */
const toFareSummary = (fare) => {
  if (!fare || !fare.fareCalculation?.pricingPolicy) return null;

  const scale = fare.fareCalculation.pricingPolicy.roundingScale;

  return {
    fare: formatMoney(fare.finalFare, chargeScale(fare.finalFare, scale)),
    currency: fare.currency,
    finalized: fare.fareCalculation?.status === 'FINALIZED',
    poolVersion: fare.fareCalculation?.poolVersion ?? null,
  };
};

/** One stop, as the passenger's own plan describes it. */
const toStopDto = (stop) => ({
  stopId: stop.id,
  sequence: stop.sequence,
  stopType: stop.stopType,
  status: stop.status,
  servicePoint: toServicePoint(stop.servicePoint),
  plannedArrivalAt: toIsoString(stop.plannedArrivalAt),
  actualArrivalAt: toIsoString(stop.actualArrivalAt),
  completedAt: toIsoString(stop.completedAt),
});

/**
 * The passenger's position in their own journey.
 *
 * `stage` comes from `passengerTripStage` and `nextAction` from
 * `passengerNextAction`, so a step tracker and a button are two renderings of one
 * answer instead of two computations that can drift apart.
 *
 * The arrival instant is the *passenger's own* pickup stop's, found here rather
 * than passed in, so there is one place that decides which stop counts as theirs.
 */
const toStage = (request, member, stops) =>
  passengerTripStage({
    requestStatus: request.status,
    departedAt: member?.ridePool?.departedAt ?? null,
    arrivedAt: stops.find((stop) => stop.stopType === 'PICKUP')?.actualArrivalAt ?? null,
    pickedUpAt: member?.pickedUpAt ?? null,
    droppedOffAt: member?.droppedOffAt ?? null,
  });

/**
 * One row of the passenger's history.
 *
 * `startedAt` and `completedAt` are the *request's* own instants -- when this
 * passenger's ride began and ended -- not the pool's. A passenger is delivered
 * while the pool may still be carrying somebody else, so the pool's completion
 * would be the wrong timestamp to show them.
 */
export const toRideSummaryDto = ({ request, fare }) => {
  const member = request.poolMember ?? null;
  const pool = member?.ridePool ?? null;

  return {
    rideRequestId: request.id,
    status: request.status,
    cancellable: isCancellable(request.status),
    pickup: toServicePoint(request.pickupServicePoint),
    destination: toServicePoint(request.dropoffServicePoint),

    requestedAt: toIsoString(request.requestedAt),
    startedAt: toIsoString(request.startedAt),
    completedAt: toIsoString(request.completedAt),
    cancelledAt: toIsoString(request.cancelledAt),

    // The route the passenger agreed to when they accepted the quote: the
    // distance and duration their fare was based on.
    route: {
      distanceMeters: request.acceptedDistanceMeters,
      durationSeconds: request.acceptedDurationSeconds,
    },

    soloEstimate: {
      fare: formatMoney(
        request.acceptedFare,
        chargeScale(request.acceptedFare, quoteRoundingScale(request.fareQuote)),
      ),
      currency: request.currency,
      pricingCode: request.acceptedPricingCode,
      pricingVersion: request.acceptedPricingVersion,
    },

    // The final shared fare when there is one. Null before a match, when there is
    // no pooled fare to report -- and reported as null rather than "0.00", which
    // would be inventing an answer.
    sharedFare: toFareSummary(fare),

    driver: toDriverSummary(pool),
    vehicle: toVehicleSummary(pool),

    // Aggregate only. The rows behind this count are never read.
    passengerCount: pool?._count?.members ?? null,
  };
};

/**
 * The ride the passenger is on now.
 *
 * Everything a summary has, plus what a passenger actively watching a journey
 * needs: where the car is in the plan, their own two stops, and the single thing
 * they can do next.
 *
 * `pool` reports the pool's own status and its completion instant, which a
 * passenger may legitimately know -- it is the vehicle they are in, not a fact
 * about the other people in it.
 */
export const toCurrentRideDto = ({ request, fare, stops = [] }) => {
  const summary = toRideSummaryDto({ request, fare });
  const member = request.poolMember ?? null;
  const pool = member?.ridePool ?? null;
  const stage = toStage(request, member, stops);

  return {
    ...summary,
    stage,
    nextAction: passengerNextAction(stage),
    searchExpiresAt: toIsoString(request.searchExpiresAt),
    memberStatus: member?.status ?? null,
    pool: pool
      ? {
          poolId: pool.id,
          status: pool.status,
          completedAt: toIsoString(pool.completedAt),
        }
      : null,
    timeline: {
      matchedAt: toIsoString(member?.matchedAt),
      departedAt: toIsoString(pool?.departedAt),
      driverArrivedAt: toIsoString(
        stops.find((stop) => stop.stopType === 'PICKUP')?.actualArrivalAt ?? null,
      ),
      pickedUpAt: toIsoString(member?.pickedUpAt),
      droppedOffAt: toIsoString(member?.droppedOffAt),
    },
    myStops: stops.map(toStopDto),
  };
};

/**
 * The current ride, or nothing.
 *
 * `ride: null` rather than a `404`: not being on a journey is a normal state, not
 * a missing resource, and a client polling this endpoint should not have to treat
 * the ordinary answer as an error. It is the same choice the driver's
 * current-pool endpoint makes, so both sides of the app behave alike.
 */
export const toCurrentRideEnvelope = (ride) => ({
  ride: ride ? toCurrentRideDto(ride) : null,
});

/**
 * A page of history.
 *
 * `data` and `pagination` match `GET /ride-requests/my`, which is the shape this
 * project already publishes for a list. `earliest`/`latest` are omitted on
 * purpose: the two are only useful for a date filter, and a client that filtered
 * by date already knows the range it asked for.
 */
export const toRideHistoryDto = ({ rides, total, limit, offset }) => ({
  data: rides.map(toRideSummaryDto),
  pagination: {
    limit,
    offset,
    returned: rides.length,
    total,
    hasMore: offset + rides.length < total,
  },
});

/**
 * One ride, in detail.
 *
 * Adds three things to a summary: the passenger's own stops, the passenger's own
 * lifecycle timeline, and a pool block describing the journey they shared.
 *
 * The timeline is produced by `timeline.rules.js`, which drops every dispatch
 * event (`DRIVER_OFFERED`, `POOL_CANDIDATE_EVALUATED`, `DRIVER_REJECTED`, …) and
 * never reads `metadata`. A client gets sentences, not audit rows.
 */
export const toRideDetailDto = ({ request, fare, stops, events }) => {
  const summary = toRideSummaryDto({ request, fare });
  const member = request.poolMember ?? null;
  const pool = member?.ridePool ?? null;
  const stage = toStage(request, member, stops);

  return {
    ...summary,
    stage,
    nextAction: passengerNextAction(stage),

    searchExpiresAt: toIsoString(request.searchExpiresAt),
    memberStatus: member?.status ?? null,

    // The passenger's own two stops, in the order they happen. The query that
    // reads them is filtered by this request, so a co-passenger's stop cannot
    // appear here.
    myStops: stops.map(toStopDto),

    // The plan the passenger actually travelled: the pool's planned route once
    // matched, which is the shared plan, and the accepted quote before that.
    sharedRoute: pool
      ? {
          distanceMeters: Number(pool.plannedDistanceMeters),
          durationSeconds: pool.plannedDurationSeconds,
        }
      : null,

    pool: pool
      ? {
          poolId: pool.id,
          status: pool.status,
          passengerCount: pool._count?.members ?? null,
          capacity: pool.capacitySnapshot,
          completedAt: toIsoString(pool.completedAt),
        }
      : null,

    // Their own member state, so a client can render "you were picked up" without
    // inferring it from two timestamps.
    member: member
      ? {
          memberStatus: member.status,
          matchedAt: toIsoString(member.matchedAt),
          pickedUpAt: toIsoString(member.pickedUpAt),
          droppedOffAt: toIsoString(member.droppedOffAt),
        }
      : null,

    timeline: toTimeline(events, TIMELINE_AUDIENCE.PASSENGER),
  };
};
