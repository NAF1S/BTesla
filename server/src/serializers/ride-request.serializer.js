import { chargeScale, formatMoney } from '../services/fare.calculator.js';
import { isCancellable } from '../services/ride.status.js';
import { passengerTripStage } from '../services/trip.rules.js';
import { quoteRoundingScale } from './fare.serializer.js';

/**
 * The passenger's view of a ride request.
 *
 * A whitelist, like every other serializer here. What it deliberately never
 * contains:
 *
 *   * `requestFingerprint` -- an internal idempotency detail with no meaning to
 *     a client, and one a client could otherwise try to influence;
 *   * any other passenger, and any identifier that could address one;
 *   * the row lock, the raw quote, the route snapshot, or any pricing rate --
 *     the accepted values are summarised, not dumped;
 *   * event metadata. History is recorded for audit, and a passenger is given
 *     their own timeline as events and instants -- not the payloads behind them,
 *     which name pools, offers and drivers.
 *
 * The accepted money is a frozen copy made at request time, so it cannot drift:
 * it is presented as the whole number of taka it is, or at the quote's own scale
 * if it predates the rounding rule.
 *
 * ---------------------------------------------------------------------------
 * THE TRIP IS OPTIONAL, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 * `trip` is passed in by the caller for a single request (`GET /ride-requests/:id`,
 * the passenger's current ride) and left out of list pages, where reading the
 * pool, the stops and the timeline of every row would be a query per row to
 * answer a question the page is not asking.
 */

const toIsoString = (value) => (value ? new Date(value).toISOString() : null);

const toTripStopDto = (stop) => ({
  stopId: stop.id,
  sequence: stop.sequence,
  stopType: stop.stopType,
  status: stop.status,
  servicePoint: stop.servicePoint
    ? { code: stop.servicePoint.code, name: stop.servicePoint.name }
    : null,
  plannedArrivalAt: toIsoString(stop.plannedArrivalAt),
  actualArrivalAt: toIsoString(stop.actualArrivalAt),
  completedAt: toIsoString(stop.completedAt),
});

/**
 * The passenger's own part of the trip: who is driving, where they are in the
 * journey, and what has happened so far.
 *
 * Every field is about *this* passenger. The pool's status and departure are
 * shared facts, the arrival instant is their own pickup stop's, and the
 * timestamps are the ones this ride produced -- including the completion of their
 * ride, which happens while the pool may still be carrying somebody else.
 */
const toPassengerTripDto = ({ member, pool, stops, events }, requestStatus) => {
  if (!member || !pool) return null;

  const pickupStop = stops.find((stop) => stop.stopType === 'PICKUP') ?? null;
  const nextStop = stops.find((stop) => stop.status !== 'COMPLETED') ?? null;

  return {
    poolId: pool.id,
    poolStatus: pool.status,
    memberStatus: member.status,
    stage: passengerTripStage({
      requestStatus,
      departedAt: pool.departedAt,
      arrivedAt: pickupStop?.actualArrivalAt ?? null,
      pickedUpAt: member.pickedUpAt,
      droppedOffAt: member.droppedOffAt,
    }),
    driver: {
      displayName: pool.driverProfile?.user?.name
        ? pool.driverProfile.user.name.split(/\s+/)[0]
        : null,
    },
    vehicle: pool.vehicle
      ? { name: pool.vehicle.name, seatCapacity: pool.vehicle.seatCapacity }
      : null,
    stops: stops.map(toTripStopDto),
    nextStop: nextStop ? toTripStopDto(nextStop) : null,
    timeline: {
      matchedAt: toIsoString(member.matchedAt),
      departedAt: toIsoString(pool.departedAt),
      driverArrivedAt: toIsoString(pickupStop?.actualArrivalAt),
      pickedUpAt: toIsoString(member.pickedUpAt),
      droppedOffAt: toIsoString(member.droppedOffAt),
    },
    events: events.map((event) => ({
      sequence: event.sequence,
      eventType: event.eventType,
      actorType: event.actorType,
      createdAt: toIsoString(event.createdAt),
    })),
  };
};

/**
 * `cancellable` is derived, never stored: it is true exactly while the request
 * is WAITING, which is also the only status the cancellation operation accepts.
 */
export const toRideRequestDto = (request, { trip = null } = {}) => {
  const acceptedFareScale = chargeScale(
    request.acceptedFare,
    quoteRoundingScale(request.fareQuote),
  );

  return {
    id: request.id,
    status: request.status,
    cancellable: isCancellable(request.status),
    pickup: {
      code: request.pickupServicePoint.code,
      name: request.pickupServicePoint.name,
    },
    destination: {
      code: request.dropoffServicePoint.code,
      name: request.dropoffServicePoint.name,
    },
    acceptedQuote: {
      fareQuoteId: request.fareQuoteId,
      fare: formatMoney(request.acceptedFare, acceptedFareScale),
      currency: request.currency,
      pricingCode: request.acceptedPricingCode,
      pricingVersion: request.acceptedPricingVersion,
      distanceMeters: request.acceptedDistanceMeters,
      durationSeconds: request.acceptedDurationSeconds,
    },
    requestedAt: toIsoString(request.requestedAt),
    searchExpiresAt: toIsoString(request.searchExpiresAt),
    startedAt: toIsoString(request.startedAt),
    completedAt: toIsoString(request.completedAt),
    cancelledAt: toIsoString(request.cancelledAt),
    cancellationReason: request.cancellationReason ?? null,
    trip: trip ? toPassengerTripDto(trip, request.status) : null,
  };
};

/**
 * The passenger's history page.
 *
 * `data` matches the shape of the other list endpoints; `pagination` is added so
 * a client can page without guessing how many rows exist.
 */
export const toRideRequestListDto = ({ requests, total, limit, offset }) => ({
  data: requests.map(toRideRequestDto),
  pagination: {
    limit,
    offset,
    returned: requests.length,
    total,
    hasMore: offset + requests.length < total,
  },
});
