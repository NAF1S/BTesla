import { POOL_MEMBER_STATUS, POOL_STATUS, POOL_STOP_STATUS, POOL_STOP_TYPE } from './dispatch.rules.js';

/**
 * The driver-operated trip as data: who may do what, in which order, and what
 * the answer is when they do it twice.
 *
 * Nothing here touches the database. The six operations in trip.service.js ask
 * these functions what to do and then do exactly that, which is what keeps the
 * rules unit-testable and keeps one definition of them for the service, the
 * timestamps in server/db/12-driver-trip.sql, the events, and the
 * `allowedActions` the driver's client is given.
 *
 * ---------------------------------------------------------------------------
 * THE POOL'S TRIP
 * ---------------------------------------------------------------------------
 *     FORMING         the pool is being matched into; nobody has set off
 *     DRIVER_EN_ROUTE the driver has departed and is on their way
 *     ARRIVED         the driver is at their first pickup stop
 *     IN_PROGRESS     the passengers on board are riding
 *     COMPLETED       every passenger has been delivered
 *
 * Departure is what closes the pool to matching: once the status is no longer
 * FORMING, shared matching will not consider it, so no passenger is added to a
 * plan that is already being driven.
 *
 * ---------------------------------------------------------------------------
 * THE PASSENGER'S RIDE
 * ---------------------------------------------------------------------------
 *     ASSIGNED -> PICKED_UP -> DROPPED_OFF      (pool_members)
 *     MATCHED  -> IN_PROGRESS -> COMPLETED      (ride_requests)
 *
 * The two are not the same clock. A passenger is picked up while their request
 * is still MATCHED -- the ride begins when the driver starts the trip, or, for a
 * passenger collected during a trip that has already started, the moment they
 * get in. And a passenger is delivered, with their request COMPLETED, while the
 * pool may still be carrying somebody else: the pool is only COMPLETED when the
 * last of them is delivered.
 *
 * ---------------------------------------------------------------------------
 * STOP ORDER, AND WHY A STOP IS ONE PASSENGER
 * ---------------------------------------------------------------------------
 * A `pool_stops` row names one member and one stop type (`pool_stops_member_type_unique`),
 * so two passengers collected at the same corner are *two* stops at the same
 * service point, in consecutive order. That is what makes "a shared stop stays
 * open until every pickup there is done" fall out of the one rule everything
 * else uses:
 *
 *     the next actionable stop is the lowest-sequence stop that is not COMPLETED
 *
 * After one of the two pickups the other is still the next actionable stop, so
 * it cannot be skipped, and the driver cannot reach a later stop first. Every
 * operation works on the next actionable stop and refuses any other.
 *
 * Each operation answers with one of three decisions:
 *
 *     APPLY   do it
 *     REPEAT  this exact operation already succeeded; return the state as it is
 *             (no timestamp moved, no event written)
 *     REFUSE  the resources exist but the order or state is wrong: a conflict
 */

const { FORMING, DRIVER_EN_ROUTE, ARRIVED, IN_PROGRESS, COMPLETED, CANCELLED } = POOL_STATUS;

/** What a driver may be told they can do next. */
export const TRIP_ACTION = Object.freeze({
  /** POST /drivers/me/pools/:poolId/depart */
  DEPART: 'DEPART',
  /** POST /drivers/me/pools/:poolId/stops/:stopId/arrive */
  ARRIVE_AT_STOP: 'ARRIVE_AT_STOP',
  /** POST /drivers/me/pools/:poolId/stops/:stopId/members/:memberId/pickup */
  PICKUP_PASSENGER: 'PICKUP_PASSENGER',
  /** POST /drivers/me/pools/:poolId/start */
  START_TRIP: 'START_TRIP',
  /** POST /drivers/me/pools/:poolId/stops/:stopId/members/:memberId/dropoff */
  DROPOFF_PASSENGER: 'DROPOFF_PASSENGER',
  /** POST /drivers/me/pools/:poolId/complete */
  COMPLETE_TRIP: 'COMPLETE_TRIP',
});

export const TRIP_ACTIONS = Object.freeze(Object.values(TRIP_ACTION));

export const TRIP_DECISION = Object.freeze({
  APPLY: 'APPLY',
  REPEAT: 'REPEAT',
  REFUSE: 'REFUSE',
});

/** Why an operation cannot be applied. Each is reported by name and stored nowhere. */
export const TRIP_REJECTION = Object.freeze({
  POOL_NOT_FORMING: 'POOL_NOT_FORMING',
  POOL_NOT_DEPARTED: 'POOL_NOT_DEPARTED',
  POOL_NOT_ARRIVED: 'POOL_NOT_ARRIVED',
  POOL_NOT_IN_PROGRESS: 'POOL_NOT_IN_PROGRESS',
  NO_MEMBERS: 'NO_MEMBERS',
  INCOMPLETE_PLAN: 'INCOMPLETE_PLAN',
  STOPS_ALREADY_STARTED: 'STOPS_ALREADY_STARTED',
  STOP_NOT_NEXT: 'STOP_NOT_NEXT',
  STOP_NOT_PENDING: 'STOP_NOT_PENDING',
  STOP_NOT_ARRIVED: 'STOP_NOT_ARRIVED',
  MEMBER_NOT_ON_STOP: 'MEMBER_NOT_ON_STOP',
  WRONG_STOP_TYPE: 'WRONG_STOP_TYPE',
  MEMBER_NOT_ASSIGNED: 'MEMBER_NOT_ASSIGNED',
  MEMBER_NOT_PICKED_UP: 'MEMBER_NOT_PICKED_UP',
  REQUEST_NOT_MATCHED: 'REQUEST_NOT_MATCHED',
  REQUEST_NOT_IN_PROGRESS: 'REQUEST_NOT_IN_PROGRESS',
  NO_MEMBER_PICKED_UP: 'NO_MEMBER_PICKED_UP',
  PICKUP_ACTION_OPEN: 'PICKUP_ACTION_OPEN',
  FARE_NOT_FINALIZED: 'FARE_NOT_FINALIZED',
  STOPS_UNFINISHED: 'STOPS_UNFINISHED',
  MEMBERS_ONBOARD: 'MEMBERS_ONBOARD',
  REQUESTS_UNFINISHED: 'REQUESTS_UNFINISHED',
});

const apply = () => ({ decision: TRIP_DECISION.APPLY });
const repeat = () => ({ decision: TRIP_DECISION.REPEAT });
const refuse = (reason, message) => ({ decision: TRIP_DECISION.REFUSE, reason, message });

/**
 * The pool statuses a trip passes through, and the only moves it makes.
 *
 * `canChangePoolStatus` is the definition; the trip's operations consult it
 * rather than restating the order, so "can this happen?" has one answer. Like
 * `ALLOWED_TRANSITIONS` in ride.status.js, the table includes every legal move,
 * and the operations below are what actually make them.
 */
export const POOL_STATUS_TRANSITIONS = Object.freeze({
  [FORMING]: Object.freeze([DRIVER_EN_ROUTE]),
  [DRIVER_EN_ROUTE]: Object.freeze([ARRIVED]),
  [ARRIVED]: Object.freeze([IN_PROGRESS]),
  [IN_PROGRESS]: Object.freeze([COMPLETED]),
  [COMPLETED]: Object.freeze([]),
  [CANCELLED]: Object.freeze([]),
});

export const canChangePoolStatus = (from, to) =>
  Array.isArray(POOL_STATUS_TRANSITIONS[from]) && POOL_STATUS_TRANSITIONS[from].includes(to);

/** A pool that has left FORMING is under way, and closed to matching. */
export const hasDeparted = (status) =>
  [DRIVER_EN_ROUTE, ARRIVED, IN_PROGRESS, COMPLETED].includes(status);

/** A pool with a trip in it. A COMPLETED pool is over, not under way. */
export const isTripActive = (status) => [DRIVER_EN_ROUTE, ARRIVED, IN_PROGRESS].includes(status);

/** Who is physically in the vehicle: collected, not yet delivered. */
export const onboardMemberIds = (members) =>
  members
    .filter((member) => member.status === POOL_MEMBER_STATUS.PICKED_UP)
    .map((member) => member.id);

/**
 * The plan, in the order it is driven.
 *
 * The sequence numbers are unique per pool and are what the order *is*; sorting
 * here rather than trusting the caller means a caller cannot reorder the trip by
 * reading the rows in a different order.
 */
export const orderedStops = (stops) => [...stops].sort((a, b) => a.sequence - b.sequence);

/** The lowest-sequence stop whose status is not COMPLETED. Null when the plan is done. */
export const nextActionableStop = (stops) =>
  orderedStops(stops).find((stop) => stop.status !== POOL_STOP_STATUS.COMPLETED) ?? null;

/** The stop the driver has to be at before the trip can begin: the first pickup. */
export const firstPickupStop = (stops) =>
  orderedStops(stops).find((stop) => stop.stopType === POOL_STOP_TYPE.PICKUP) ?? null;

/** The last stop the plan delivers to: where the driver ends up. */
export const finalDropoffStop = (stops) => {
  const dropoffs = orderedStops(stops).filter((stop) => stop.stopType === POOL_STOP_TYPE.DROPOFF);
  return dropoffs.length === 0 ? null : dropoffs[dropoffs.length - 1];
};

export const memberById = (members, memberId) =>
  members.find((member) => member.id === memberId) ?? null;

const stopsOfMember = (stops, memberId) =>
  orderedStops(stops).filter((stop) => stop.poolMemberId === memberId);

/**
 * Whether a plan can be driven at all: every member has a pickup before their
 * own drop-off, the sequences are the contiguous order the driver follows, and
 * there is at least one of each stop type.
 *
 * A plan that fails this cannot be departed, and cannot be repaired here -- it
 * means the pool was written wrong, which is why the same shape is checked in
 * `pool-fare.rules.js` before it is priced.
 */
export const planIsProcessable = ({ stops, members }) => {
  if (members.length === 0 || stops.length < 2) return false;

  const ordered = orderedStops(stops);
  if (ordered.some((stop, index) => stop.sequence !== index + 1)) return false;

  if (!ordered.some((stop) => stop.stopType === POOL_STOP_TYPE.PICKUP)) return false;
  if (!ordered.some((stop) => stop.stopType === POOL_STOP_TYPE.DROPOFF)) return false;

  return members.every((member) => {
    const own = stopsOfMember(stops, member.id);
    const pickup = own.find((stop) => stop.stopType === POOL_STOP_TYPE.PICKUP);
    const dropoff = own.find((stop) => stop.stopType === POOL_STOP_TYPE.DROPOFF);

    return Boolean(pickup && dropoff && pickup.sequence < dropoff.sequence);
  });
};

/**
 * Whether a stop's own action is still open.
 *
 * A pickup stop is finished once its member is collected, a drop-off stop once
 * they are delivered. The stop's `status` is what the driver did; the member's is
 * what happened to the passenger, and the operation writes both together.
 */
export const stopActionIsOpen = (stop, members) => {
  const member = memberById(members, stop.poolMemberId);
  if (!member) return true;

  return stop.stopType === POOL_STOP_TYPE.PICKUP
    ? member.status === POOL_MEMBER_STATUS.ASSIGNED
    : member.status !== POOL_MEMBER_STATUS.DROPPED_OFF;
};

// ---------------------------------------------------------------------------
// Departure
// ---------------------------------------------------------------------------

/**
 * Leaving for the first pickup.
 *
 * The pool has been matched and its passengers are waiting; departing is what
 * commits the driver to the plan, closes the pool to further matching, freezes
 * the fare the trip will run under, and frees the driver's attention.
 */
export const decideDepart = ({ pool, stops, members }) => {
  if (hasDeparted(pool.status)) {
    // An earlier departure already succeeded (or the trip is over): a retry of
    // the same command must not fail, and must not move a timestamp.
    return repeat();
  }

  if (pool.status !== FORMING) {
    return refuse(
      TRIP_REJECTION.POOL_NOT_FORMING,
      `This pool is ${pool.status.toLowerCase()} and cannot depart`,
    );
  }

  if (members.length === 0) {
    return refuse(TRIP_REJECTION.NO_MEMBERS, 'A pool with no passengers has nothing to drive');
  }

  if (!planIsProcessable({ stops, members })) {
    return refuse(
      TRIP_REJECTION.INCOMPLETE_PLAN,
      'This pool has no drivable plan: every passenger needs a pickup before their drop-off',
    );
  }

  if (stops.some((stop) => stop.status !== POOL_STOP_STATUS.PENDING)) {
    return refuse(
      TRIP_REJECTION.STOPS_ALREADY_STARTED,
      'This pool already has a stop in progress and cannot depart',
    );
  }

  return apply();
};

// ---------------------------------------------------------------------------
// Arriving at a stop
// ---------------------------------------------------------------------------

/**
 * Reaching a stop.
 *
 * Only the next actionable stop may be reached, so the driver cannot jump ahead
 * to a later passenger. Reaching the *first* pickup is what moves the pool out of
 * DRIVER_EN_ROUTE: from then on the pool is ARRIVED until the trip starts, and
 * later arrivals leave it exactly as it is.
 */
export const decideArrival = ({ pool, stop, stops }) => {
  if (!stop || !stops.some((candidate) => candidate.id === stop.id)) {
    return refuse(TRIP_REJECTION.STOP_NOT_NEXT, 'That stop is not part of this pool');
  }

  // A stop that has been reached, or already finished, is a retry of an arrival
  // that succeeded -- including after the trip itself is over. The driver is told
  // where they are, and nothing moves.
  if (stop.status !== POOL_STOP_STATUS.PENDING) return repeat();

  if (!isTripActive(pool.status)) {
    return refuse(
      TRIP_REJECTION.POOL_NOT_DEPARTED,
      hasDeparted(pool.status)
        ? 'This pool has already completed its trip'
        : 'This pool has not departed yet',
    );
  }

  const next = nextActionableStop(stops);
  if (!next || next.id !== stop.id) {
    return refuse(
      TRIP_REJECTION.STOP_NOT_NEXT,
      next
        ? `Stop ${stop.sequence} cannot be reached before stop ${next.sequence}`
        : 'Every stop has already been completed',
    );
  }

  return apply();
};

// ---------------------------------------------------------------------------
// Collecting a passenger
// ---------------------------------------------------------------------------

/**
 * Confirming that a passenger is in the vehicle.
 *
 * The stop has to have been reached, and it has to be the stop *that passenger*
 * is collected from -- which is what stops a driver completing somebody else's
 * stop by naming the wrong member. A passenger collected during a trip that has
 * already started begins their ride immediately; one collected before the trip
 * starts stays MATCHED until the driver starts it.
 */
export const decidePickup = ({ pool, stop, member, stops, members }) => {
  if (!stop || !stops.some((candidate) => candidate.id === stop.id)) {
    return refuse(TRIP_REJECTION.STOP_NOT_NEXT, 'That stop is not part of this pool');
  }

  if (!member || !members.some((candidate) => candidate.id === member.id)) {
    return refuse(TRIP_REJECTION.MEMBER_NOT_ON_STOP, 'That passenger is not in this pool');
  }

  if (stop.poolMemberId !== member.id) {
    return refuse(
      TRIP_REJECTION.MEMBER_NOT_ON_STOP,
      'That passenger is collected from a different stop in this pool',
    );
  }

  if (stop.stopType !== POOL_STOP_TYPE.PICKUP) {
    return refuse(TRIP_REJECTION.WRONG_STOP_TYPE, 'That stop is a drop-off, not a pickup');
  }

  // Already collected (or already delivered): the pickup succeeded earlier --
  // including after the trip is over, where every passenger is out.
  if (member.status !== POOL_MEMBER_STATUS.ASSIGNED) return repeat();

  if (![ARRIVED, IN_PROGRESS].includes(pool.status)) {
    return refuse(
      TRIP_REJECTION.POOL_NOT_ARRIVED,
      `A passenger is collected once the driver has reached the pickup (this pool is ${pool.status.toLowerCase()})`,
    );
  }

  if (stop.status !== POOL_STOP_STATUS.ARRIVED) {
    return stop.status === POOL_STOP_STATUS.PENDING
      ? refuse(TRIP_REJECTION.STOP_NOT_ARRIVED, 'This stop has not been reached yet')
      : repeat();
  }

  const next = nextActionableStop(stops);
  if (!next || next.id !== stop.id) {
    return refuse(
      TRIP_REJECTION.STOP_NOT_NEXT,
      next
        ? `Stop ${stop.sequence} cannot be served before stop ${next.sequence}`
        : 'Every stop has already been completed',
    );
  }

  if (member.requestStatus !== 'MATCHED') {
    return refuse(
      TRIP_REJECTION.REQUEST_NOT_MATCHED,
      `This passenger's ride is ${String(member.requestStatus).toLowerCase()}, and is not waiting to be collected`,
    );
  }

  return apply();
};

// ---------------------------------------------------------------------------
// Starting the trip
// ---------------------------------------------------------------------------

/**
 * Starting the journey with the passengers who are already in the vehicle.
 *
 * The trip cannot start at a stop where a pickup is still outstanding -- the
 * driver is standing at the car -- but it can start with a *later* pickup still
 * ahead of it, which is what makes a pooled trip IN_PROGRESS while a passenger
 * waiting further along the route is still MATCHED.
 */
export const decideStart = ({ pool, stops, members, fare }) => {
  if (pool.status === IN_PROGRESS || pool.status === COMPLETED) return repeat();

  if (pool.status !== ARRIVED) {
    return refuse(
      TRIP_REJECTION.POOL_NOT_ARRIVED,
      `A trip starts once the driver has reached the first pickup (this pool is ${pool.status.toLowerCase()})`,
    );
  }

  if (!planIsProcessable({ stops, members })) {
    return refuse(TRIP_REJECTION.INCOMPLETE_PLAN, 'This pool has no drivable plan');
  }

  if (onboardMemberIds(members).length === 0) {
    return refuse(TRIP_REJECTION.NO_MEMBER_PICKED_UP, 'No passenger has been collected yet');
  }

  const next = nextActionableStop(stops);
  if (next && next.stopType === POOL_STOP_TYPE.PICKUP && stopActionIsOpen(next, members)) {
    return refuse(
      TRIP_REJECTION.PICKUP_ACTION_OPEN,
      `Passengers are still being collected at stop ${next.sequence}`,
    );
  }

  if (!fare || !fare.finalizedAt) {
    return refuse(
      TRIP_REJECTION.FARE_NOT_FINALIZED,
      'This trip has no finalized shared fare to run under',
    );
  }

  return apply();
};

// ---------------------------------------------------------------------------
// Delivering a passenger
// ---------------------------------------------------------------------------

/**
 * Confirming that a passenger has been delivered.
 *
 * Delivering completes *that passenger's* ride and no more: their stop finishes,
 * their request is COMPLETED and their ride is in their history, while the pool
 * carries on with whoever is still aboard.
 */
export const decideDropoff = ({ pool, stop, member, stops, members }) => {
  if (!stop || !stops.some((candidate) => candidate.id === stop.id)) {
    return refuse(TRIP_REJECTION.STOP_NOT_NEXT, 'That stop is not part of this pool');
  }

  if (!member || !members.some((candidate) => candidate.id === member.id)) {
    return refuse(TRIP_REJECTION.MEMBER_NOT_ON_STOP, 'That passenger is not in this pool');
  }

  if (stop.poolMemberId !== member.id) {
    return refuse(
      TRIP_REJECTION.MEMBER_NOT_ON_STOP,
      'That passenger is delivered to a different stop in this pool',
    );
  }

  if (stop.stopType !== POOL_STOP_TYPE.DROPOFF) {
    return refuse(TRIP_REJECTION.WRONG_STOP_TYPE, 'That stop is a pickup, not a drop-off');
  }

  // Already delivered: the drop-off succeeded earlier, whatever the pool has
  // moved on to.
  if (member.status === POOL_MEMBER_STATUS.DROPPED_OFF) return repeat();

  if (pool.status !== IN_PROGRESS) {
    return refuse(
      TRIP_REJECTION.POOL_NOT_IN_PROGRESS,
      `A passenger is delivered during a trip (this pool is ${pool.status.toLowerCase()})`,
    );
  }

  if (member.status !== POOL_MEMBER_STATUS.PICKED_UP) {
    return refuse(
      TRIP_REJECTION.MEMBER_NOT_PICKED_UP,
      'That passenger has not been collected yet, so they cannot be delivered',
    );
  }

  if (stop.status !== POOL_STOP_STATUS.ARRIVED) {
    return stop.status === POOL_STOP_STATUS.PENDING
      ? refuse(TRIP_REJECTION.STOP_NOT_ARRIVED, 'This stop has not been reached yet')
      : repeat();
  }

  const next = nextActionableStop(stops);
  if (!next || next.id !== stop.id) {
    return refuse(
      TRIP_REJECTION.STOP_NOT_NEXT,
      next
        ? `Stop ${stop.sequence} cannot be served before stop ${next.sequence}`
        : 'Every stop has already been completed',
    );
  }

  if (member.requestStatus !== 'IN_PROGRESS') {
    return refuse(
      TRIP_REJECTION.REQUEST_NOT_IN_PROGRESS,
      `This passenger's ride is ${String(member.requestStatus).toLowerCase()} and cannot be completed`,
    );
  }

  return apply();
};

// ---------------------------------------------------------------------------
// Completing the trip
// ---------------------------------------------------------------------------

/**
 * Finishing the pool.
 *
 * Completion is only ever about facts: every stop served, every passenger
 * delivered, every ride completed, nobody left in the vehicle, and a fare that
 * was frozen before the trip began. There is no "close it anyway", because a pool
 * that completes with a passenger aboard would strand a ride request in a state
 * no later operation could fix.
 */
export const decideCompletion = ({ pool, stops, members, fare }) => {
  if (pool.status === COMPLETED) return repeat();

  if (pool.status !== IN_PROGRESS) {
    return refuse(
      TRIP_REJECTION.POOL_NOT_IN_PROGRESS,
      `A trip is completed once it is under way (this pool is ${pool.status.toLowerCase()})`,
    );
  }

  const ordered = orderedStops(stops);
  const unfinished = ordered.filter((stop) => stop.status !== POOL_STOP_STATUS.COMPLETED);

  if (ordered.length === 0 || unfinished.length > 0) {
    return refuse(
      TRIP_REJECTION.STOPS_UNFINISHED,
      unfinished.length > 0
        ? `Stop ${unfinished[0].sequence} has not been completed`
        : 'This pool has no stops to complete',
    );
  }

  const active = members.filter(
    (member) =>
      member.status !== POOL_MEMBER_STATUS.CANCELLED && member.status !== POOL_MEMBER_STATUS.NO_SHOW,
  );

  const onboard = active.filter((member) => member.status === POOL_MEMBER_STATUS.PICKED_UP);
  if (onboard.length > 0) {
    return refuse(
      TRIP_REJECTION.MEMBERS_ONBOARD,
      `${onboard.length} passenger(s) are still in the vehicle`,
    );
  }

  const undelivered = active.filter((member) => member.status !== POOL_MEMBER_STATUS.DROPPED_OFF);
  if (undelivered.length > 0) {
    return refuse(TRIP_REJECTION.MEMBERS_ONBOARD, 'Not every passenger has been delivered');
  }

  const unfinishedRides = active.filter((member) => member.requestStatus !== 'COMPLETED');
  if (unfinishedRides.length > 0) {
    return refuse(
      TRIP_REJECTION.REQUESTS_UNFINISHED,
      'Not every ride in this pool has been completed',
    );
  }

  if (!fare || !fare.finalizedAt) {
    return refuse(
      TRIP_REJECTION.FARE_NOT_FINALIZED,
      'This trip has no finalized shared fare',
    );
  }

  return apply();
};

/**
 * What a passenger is told about their own ride.
 *
 * The stages are derived from the facts, never stored: a stored stage is a second
 * source of truth that can disagree with the timestamps that justify it. They are
 * what the passenger's current-ride endpoint reports, in order:
 *
 *     DRIVER_ASSIGNED   a driver accepted; nobody has set off
 *     DRIVER_EN_ROUTE   the driver left for the first pickup
 *     DRIVER_ARRIVED    the car is at *this* passenger's pickup
 *     PICKED_UP         this passenger is in the car, the trip has not started
 *     IN_PROGRESS       this passenger's ride has begun
 *     RIDE_COMPLETED    this passenger has been delivered
 *
 * "Dropped off" and "ride completed" are one moment in this milestone -- the
 * delivery sets both -- so there is no separate stage for the first of them.
 */
export const PASSENGER_TRIP_STAGE = Object.freeze({
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_EN_ROUTE: 'DRIVER_EN_ROUTE',
  DRIVER_ARRIVED: 'DRIVER_ARRIVED',
  PICKED_UP: 'PICKED_UP',
  IN_PROGRESS: 'IN_PROGRESS',
  RIDE_COMPLETED: 'RIDE_COMPLETED',
});

export const passengerTripStage = ({
  requestStatus,
  departedAt = null,
  arrivedAt = null,
  pickedUpAt = null,
  droppedOffAt = null,
}) => {
  if (requestStatus === 'COMPLETED' || droppedOffAt) return PASSENGER_TRIP_STAGE.RIDE_COMPLETED;
  if (requestStatus === 'IN_PROGRESS') return PASSENGER_TRIP_STAGE.IN_PROGRESS;
  if (pickedUpAt) return PASSENGER_TRIP_STAGE.PICKED_UP;
  if (arrivedAt) return PASSENGER_TRIP_STAGE.DRIVER_ARRIVED;
  if (departedAt) return PASSENGER_TRIP_STAGE.DRIVER_EN_ROUTE;

  return PASSENGER_TRIP_STAGE.DRIVER_ASSIGNED;
};

/**
 * What the driver may do next, computed from the state rather than told to the
 * client.
 *
 * An action appears only when its own decision would be APPLY: a client is never
 * offered a button that would answer 409. That also means an action that has
 * already succeeded (decision REPEAT) is not listed -- there is nothing left to
 * do about it.
 *
 *     allowedActions({ pool, stops, members, fare })
 *
 * `members` carry the status of the ride request they belong to in
 * `requestStatus`; the service injects it when it loads them.
 */
export const allowedActions = ({ pool, stops, members, fare = null }) => {
  const context = { pool, stops, members, fare };
  const actions = [];

  if (decideDepart(context).decision === TRIP_DECISION.APPLY) actions.push(TRIP_ACTION.DEPART);

  const next = nextActionableStop(stops);

  if (next) {
    if (decideArrival({ ...context, stop: next }).decision === TRIP_DECISION.APPLY) {
      actions.push(TRIP_ACTION.ARRIVE_AT_STOP);
    }

    const member = memberById(members, next.poolMemberId);

    if (
      decidePickup({ ...context, stop: next, member }).decision === TRIP_DECISION.APPLY
    ) {
      actions.push(TRIP_ACTION.PICKUP_PASSENGER);
    }

    if (
      decideDropoff({ ...context, stop: next, member }).decision === TRIP_DECISION.APPLY
    ) {
      actions.push(TRIP_ACTION.DROPOFF_PASSENGER);
    }
  }

  if (decideStart(context).decision === TRIP_DECISION.APPLY) actions.push(TRIP_ACTION.START_TRIP);
  if (decideCompletion(context).decision === TRIP_DECISION.APPLY) {
    actions.push(TRIP_ACTION.COMPLETE_TRIP);
  }

  return actions;
};

/**
 * What the passenger's client should offer next.
 *
 * The passenger's equivalent of `allowedActions`, and for the same reason: the
 * server owns the state machine, so a client is told which single thing to put on
 * screen rather than deriving it from a status and a stage and getting it subtly
 * wrong. Every value here is something the passenger can actually *do* -- waiting
 * is a state, not an action, so `WAIT_FOR_DRIVER` is the honest answer while a
 * driver is being found.
 *
 *     WAIT_FOR_DRIVER   no driver has accepted yet; there is nothing to do
 *     WATCH_DRIVER      a driver is on their way to this passenger's pickup
 *     BOARD_VEHICLE     the car is at the pickup; the passenger gets in
 *     IN_RIDE           this passenger is riding; nothing to do but wait
 *     RIDE_FINISHED     this passenger's ride is over
 *
 * `NONE` is not a value: a client that receives an unknown status is shown
 * `WAIT_FOR_DRIVER` rather than a button that would do nothing. Unknown statuses
 * are unreachable through the API, and guessing at a presentation for one is
 * worse than being boring about it.
 */
export const PASSENGER_NEXT_ACTION = Object.freeze({
  WAIT_FOR_DRIVER: 'WAIT_FOR_DRIVER',
  WATCH_DRIVER: 'WATCH_DRIVER',
  BOARD_VEHICLE: 'BOARD_VEHICLE',
  IN_RIDE: 'IN_RIDE',
  RIDE_FINISHED: 'RIDE_FINISHED',
});

/**
 * The single next action for a passenger, from their own facts.
 *
 * `stage` is the one `passengerTripStage` above produced, so the two presentations
 * -- a step in a tracker and a button -- can never disagree about where the
 * passenger is.
 */
export const passengerNextAction = (stage) => {
  switch (stage) {
    case PASSENGER_TRIP_STAGE.DRIVER_EN_ROUTE:
      return PASSENGER_NEXT_ACTION.WATCH_DRIVER;
    case PASSENGER_TRIP_STAGE.DRIVER_ARRIVED:
      return PASSENGER_NEXT_ACTION.BOARD_VEHICLE;
    case PASSENGER_TRIP_STAGE.PICKED_UP:
    case PASSENGER_TRIP_STAGE.IN_PROGRESS:
      return PASSENGER_NEXT_ACTION.IN_RIDE;
    case PASSENGER_TRIP_STAGE.RIDE_COMPLETED:
      return PASSENGER_NEXT_ACTION.RIDE_FINISHED;
    default:
      return PASSENGER_NEXT_ACTION.WAIT_FOR_DRIVER;
  }
};
