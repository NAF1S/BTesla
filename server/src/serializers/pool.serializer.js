/**
 * The driver's view of the pool they accepted.
 *
 * A whitelist, like every serializer here. The pool is a *plan*, so this is what
 * a driver needs to know before they set off: who they are collecting, from
 * where, to where, in what order, and in what vehicle.
 *
 * What it deliberately never contains:
 *
 *   * the passenger's identity beyond a display name -- no profile id, no user
 *     id, no contact details. A driver needs something to greet the rider with,
 *     not a way to look them up;
 *   * money. The passenger's fare is between the passenger and the platform, and
 *     showing it to the driver is a product decision this milestone does not
 *     take. The `fareQuoteId` is not exposed either, so a driver cannot go
 *     looking for it;
 *   * the planned route geometry. The stops name the places, which is what a
 *     driver acts on; navigation geometry belongs to the trip milestone;
 *   * anything about another pool, another driver or another passenger.
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
});

const toMemberDto = (member, stops) => ({
  poolMemberId: member.id,
  rideRequestId: member.rideRequestId,
  status: member.status,
  matchedAt: toIsoString(member.matchedAt),
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

export const toPoolDto = (pool) => {
  if (!pool) return null;

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
    acceptedAt: toIsoString(pool.acceptedAt),
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
