import { allowedActions, nextActionableStop, orderedStops } from '../services/trip.rules.js';

/**
 * The driver's view of the pool they accepted.
 *
 * A whitelist, like every serializer here. The pool is a *plan*, so this is what
 * a driver needs to know before they set off: who they are collecting, from
 * where, to where, in what order, in what vehicle -- and, once the trip is under
 * way, what the next thing to do is.
 *
 * What it deliberately never contains:
 *
 *   * the passenger's identity beyond a display name -- no profile id, no user
 *     id, no contact details. A driver needs something to greet the rider with,
 *     not a way to look them up;
 *   * money. The passenger's fare is between the passenger and the platform, and
 *     showing it to the driver is a product decision this milestone does not
 *     take. The `fareQuoteId` is not exposed either, so a driver cannot go
 *     looking for it. What *is* exposed is whether the fare is settled
 *     (`pricing.finalized`), because a trip cannot start until it is -- a
 *     boolean about the pool, not an amount;
 *   * the planned route geometry. The stops name the places, which is what a
 *     driver acts on; navigation geometry belongs to a later milestone;
 *   * anything about another pool, another driver or another passenger.
 *
 * ---------------------------------------------------------------------------
 * WHY `allowedActions` IS HERE AND NOT IN THE CLIENT
 * ---------------------------------------------------------------------------
 * The six trip commands are only valid in one order, and that order is the
 * server's business. A client that decided for itself which button was live would
 * be a second implementation of the state machine, and the one that is wrong
 * sometimes. So the state comes with the answer: `allowedActions` lists exactly
 * the commands that would succeed right now, computed by the same rules the
 * commands themselves consult. It is derived, never stored, and an action that
 * has already succeeded is deliberately absent -- there is nothing left to do.
 */

const toIsoString = (value) => (value ? new Date(value).toISOString() : null);
const toNumber = (value) => (value === null || value === undefined ? null : Number(value));

/** The passenger's display name -- the first word, and nothing else. */
const displayNameOf = (name) => (name ? name.split(/\s+/)[0] : null);

const toStopDto = (stop) => ({
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

const toMemberDto = (member, stops) => ({
  poolMemberId: member.id,
  rideRequestId: member.rideRequestId,
  status: member.status,
  rideStatus: member.rideRequest?.status ?? null,
  matchedAt: toIsoString(member.matchedAt),
  pickedUpAt: toIsoString(member.pickedUpAt),
  droppedOffAt: toIsoString(member.droppedOffAt),
  passenger: {
    displayName: displayNameOf(member.rideRequest?.passengerProfile?.user?.name),
  },
  pickup: member.rideRequest?.pickupServicePoint
    ? {
        code: member.rideRequest.pickupServicePoint.code,
        name: member.rideRequest.pickupServicePoint.name,
      }
    : null,
  destination: member.rideRequest?.dropoffServicePoint
    ? {
        code: member.rideRequest.dropoffServicePoint.code,
        name: member.rideRequest.dropoffServicePoint.name,
      }
    : null,
  // The stops of *this* member, in the order they happen.
  stops: stops
    .filter((stop) => stop.poolMemberId === member.id)
    .sort((a, b) => a.sequence - b.sequence)
    .map(toStopDto),
});

/**
 * The shape the trip's rules read, built from the loaded rows.
 *
 * Exactly the four things the rules take: the pool (for its status), its stops in
 * order, its members with the status of the ride each of them belongs to, and the
 * fare -- whose `finalizedAt` is what says a trip may start. `members` carry the
 * request's status because "may this passenger be collected" is a question about
 * the ride as well as about the member.
 */
const toRuleContext = (pool) => ({
  pool: { status: pool.status },
  stops: orderedStops(pool.stops).map((stop) => ({
    id: stop.id,
    sequence: stop.sequence,
    stopType: stop.stopType,
    status: stop.status,
    poolMemberId: stop.poolMemberId,
  })),
  members: pool.members.map((member) => ({
    id: member.id,
    status: member.status,
    rideRequestId: member.rideRequestId,
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
});

export const toPoolDto = (pool) => {
  if (!pool) return null;

  const context = toRuleContext(pool);
  const next = nextActionableStop(context.stops);

  return {
    poolId: pool.id,
    status: pool.status,
    version: pool.version,
    capacity: pool.capacitySnapshot,
    vehicle: pool.vehicle
      ? { name: pool.vehicle.name, seatCapacity: pool.vehicle.seatCapacity }
      : null,
    plan: {
      distanceMeters: toNumber(pool.plannedDistanceMeters),
      durationSeconds: pool.plannedDurationSeconds,
      // The whole plan in order, so a client does not have to reassemble it from
      // the members to know where the driver is going next.
      stopCount: pool.stops.length,
    },
    // The plan in the order it is driven, with what has happened at each stop.
    stops: orderedStops(pool.stops).map(toStopDto),
    // The lowest-sequence stop that is not done: where the driver goes next, and
    // the only stop they may serve. Null once every stop is finished.
    nextStop: next ? toStopDto(next) : null,
    // What the driver may do now, computed from the state (see the note above).
    allowedActions: allowedActions(context),
    // Whether the fare is settled: a boolean and a version, never an amount. A
    // trip cannot start until it is finalized.
    pricing: {
      finalized: pool.fareCalculations?.[0]?.status === 'FINALIZED',
      finalizedAt: toIsoString(pool.fareCalculations?.[0]?.finalizedAt),
      poolVersion: pool.fareCalculations?.[0]?.poolVersion ?? null,
    },
    acceptedAt: toIsoString(pool.acceptedAt),
    departedAt: toIsoString(pool.departedAt),
    driverArrivedAt: toIsoString(pool.driverArrivedAt),
    startedAt: toIsoString(pool.startedAt),
    completedAt: toIsoString(pool.completedAt),
    cancelledAt: toIsoString(pool.cancelledAt),
    members: pool.members.map((member) => toMemberDto(member, pool.stops)),
    // The pool's own audit trail. It carries no passenger and no money, so it is
    // safe to show the driver -- it is their record too.
    events: pool.events.map((event) => ({
      sequence: event.sequence,
      eventType: event.eventType,
      actorType: event.actorType,
      createdAt: toIsoString(event.createdAt),
    })),
  };
};
