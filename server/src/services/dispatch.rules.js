/**
 * The dispatch lifecycle as data: driver availability, offer states, pool
 * states, the rejection vocabulary, and the candidate score.
 *
 * Nothing here touches the database, which is what makes the rules
 * unit-testable and keeps one definition of them for the services, the
 * constraints in server/db/09-driver-dispatch.sql and the tests.
 *
 * ---------------------------------------------------------------------------
 * ONE REQUEST, ONE OFFER, ONE DRIVER
 * ---------------------------------------------------------------------------
 * Dispatch is sequential in this milestone: a waiting request is offered to the
 * single best candidate, and only if that driver refuses or the offer expires is
 * the next candidate considered. `ADD_PASSENGER` exists as an offer type so the
 * pooling milestone does not have to alter an enum that is already in use, but
 * this milestone creates `INITIAL_RIDE` offers and nothing else.
 *
 * ---------------------------------------------------------------------------
 * DRIVER AVAILABILITY
 * ---------------------------------------------------------------------------
 *     OFFLINE   -> AVAILABLE      (go online: profile, vehicle and point checked)
 *     AVAILABLE -> OFFLINE        (go offline)
 *     AVAILABLE -> RESERVED       (accepted a pool; trip has not started)
 *     RESERVED  -> OFFLINE        (reserved for a later milestone)
 *     RESERVED  -> ON_RIDE        (reserved: trip start)
 *     ON_RIDE   -> AVAILABLE      (reserved: trip end)
 *
 * Implemented in this milestone: OFFLINE -> AVAILABLE, AVAILABLE -> OFFLINE and
 * AVAILABLE -> RESERVED. A RESERVED or ON_RIDE driver cannot go offline through
 * the normal endpoint, which is the rule an operator would otherwise break by
 * accident on a driver's behalf.
 */

export const DRIVER_AVAILABILITY = Object.freeze({
  OFFLINE: 'OFFLINE',
  AVAILABLE: 'AVAILABLE',
  RESERVED: 'RESERVED',
  ON_RIDE: 'ON_RIDE',
});

export const DRIVER_AVAILABILITIES = Object.freeze(Object.values(DRIVER_AVAILABILITY));

/** Only an available driver may be offered a ride. */
export const DISPATCHABLE_AVAILABILITY = DRIVER_AVAILABILITY.AVAILABLE;

/**
 * Every availability change the product defines, keyed by the state it starts
 * from. The service consults this rather than a chain of ifs, so "can this
 * happen?" has one answer.
 */
export const AVAILABILITY_TRANSITIONS = Object.freeze({
  [DRIVER_AVAILABILITY.OFFLINE]: Object.freeze([DRIVER_AVAILABILITY.AVAILABLE]),
  [DRIVER_AVAILABILITY.AVAILABLE]: Object.freeze([
    DRIVER_AVAILABILITY.OFFLINE,
    DRIVER_AVAILABILITY.RESERVED,
  ]),
  [DRIVER_AVAILABILITY.RESERVED]: Object.freeze([
    DRIVER_AVAILABILITY.OFFLINE,
    DRIVER_AVAILABILITY.ON_RIDE,
  ]),
  [DRIVER_AVAILABILITY.ON_RIDE]: Object.freeze([DRIVER_AVAILABILITY.AVAILABLE]),
});

/** The availability changes this milestone performs. The rest are reserved. */
export const IMPLEMENTED_AVAILABILITY_TRANSITIONS = Object.freeze({
  [DRIVER_AVAILABILITY.OFFLINE]: Object.freeze([DRIVER_AVAILABILITY.AVAILABLE]),
  [DRIVER_AVAILABILITY.AVAILABLE]: Object.freeze([
    DRIVER_AVAILABILITY.OFFLINE,
    DRIVER_AVAILABILITY.RESERVED,
  ]),
});

export const isDriverAvailability = (value) =>
  typeof value === 'string' && DRIVER_AVAILABILITIES.includes(value);

/** True when the product allows `from -> to` at all (implemented or reserved). */
export const canChangeAvailability = (from, to) =>
  Array.isArray(AVAILABILITY_TRANSITIONS[from]) && AVAILABILITY_TRANSITIONS[from].includes(to);

/** True when this milestone actually performs `from -> to`. */
export const isImplementedAvailabilityChange = (from, to) =>
  Array.isArray(IMPLEMENTED_AVAILABILITY_TRANSITIONS[from]) &&
  IMPLEMENTED_AVAILABILITY_TRANSITIONS[from].includes(to);

/**
 * A driver may go offline themselves only while they are not committed to a
 * ride. A RESERVED driver has accepted a passenger and an ON_RIDE driver is
 * driving one; both need an operator, not an endpoint.
 */
export const canGoOffline = (status) => status === DRIVER_AVAILABILITY.AVAILABLE;

export const canGoOnline = (status) =>
  status === DRIVER_AVAILABILITY.OFFLINE || status === DRIVER_AVAILABILITY.AVAILABLE;

/**
 * A driver may report a new current point while they are free to move -- offline
 * (they are telling us where they will come online from) or available (they
 * moved). A reserved or on-ride driver is already committed to a pickup, and the
 * pool they belong to was planned from the point they accepted at.
 */
export const canSetCurrentServicePoint = (status) =>
  status === DRIVER_AVAILABILITY.OFFLINE || status === DRIVER_AVAILABILITY.AVAILABLE;

// ---------------------------------------------------------------------------
// Dispatch offers
// ---------------------------------------------------------------------------

export const OFFER_TYPE = Object.freeze({
  INITIAL_RIDE: 'INITIAL_RIDE',
  ADD_PASSENGER: 'ADD_PASSENGER',
});

/**
 * The offer type *dispatch* creates: finding a driver for a passenger who has no
 * pool of their own. A join offer (`ADD_PASSENGER`, proposing that an existing
 * pool take another passenger) is created by matching.service.js, and accepting
 * one changes a pool that already exists instead of starting one.
 */
export const IMPLEMENTED_OFFER_TYPE = OFFER_TYPE.INITIAL_RIDE;

export const OFFER_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
});

export const OFFER_STATUSES = Object.freeze(Object.values(OFFER_STATUS));

/** An offer in one of these is over, and no operation may revive it. */
export const TERMINAL_OFFER_STATUSES = Object.freeze([
  OFFER_STATUS.ACCEPTED,
  OFFER_STATUS.REJECTED,
  OFFER_STATUS.EXPIRED,
  OFFER_STATUS.CANCELLED,
]);

export const REJECTION_REASONS = Object.freeze([
  'TOO_FAR',
  'UNAVAILABLE',
  'VEHICLE_ISSUE',
  'OTHER',
]);

/** The reason recorded when a driver refuses without saying why. */
export const DEFAULT_REJECTION_REASON = 'OTHER';

export const isOfferType = (value) =>
  typeof value === 'string' && Object.values(OFFER_TYPE).includes(value);

export const isOfferStatus = (value) =>
  typeof value === 'string' && OFFER_STATUSES.includes(value);

export const isRejectionReason = (value) =>
  typeof value === 'string' && REJECTION_REASONS.includes(value);

export const isPendingOffer = (status) => status === OFFER_STATUS.PENDING;

export const isTerminalOfferStatus = (status) => TERMINAL_OFFER_STATUSES.includes(status);

/** True when an offer is past its deadline. The deadline instant is expired. */
export const isOfferExpired = (offer, at = new Date()) =>
  new Date(offer.expiresAt).getTime() <= new Date(at).getTime();

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

export const POOL_STATUS = Object.freeze({
  FORMING: 'FORMING',
  DRIVER_EN_ROUTE: 'DRIVER_EN_ROUTE',
  ARRIVED: 'ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
});

export const POOL_STATUSES = Object.freeze(Object.values(POOL_STATUS));

/**
 * The statuses that occupy the driver's single active slot -- exactly the set
 * the partial unique index `one_active_pool_per_driver` covers.
 */
export const ACTIVE_POOL_STATUSES = Object.freeze([
  POOL_STATUS.FORMING,
  POOL_STATUS.DRIVER_EN_ROUTE,
  POOL_STATUS.ARRIVED,
  POOL_STATUS.IN_PROGRESS,
]);

export const TERMINAL_POOL_STATUSES = Object.freeze([
  POOL_STATUS.COMPLETED,
  POOL_STATUS.CANCELLED,
]);

/** The only pool status this milestone creates. */
export const IMPLEMENTED_POOL_STATUS = POOL_STATUS.FORMING;

export const isPoolStatus = (value) =>
  typeof value === 'string' && POOL_STATUSES.includes(value);

export const isActivePoolStatus = (status) => ACTIVE_POOL_STATUSES.includes(status);

export const POOL_MEMBER_STATUS = Object.freeze({
  ASSIGNED: 'ASSIGNED',
  PICKED_UP: 'PICKED_UP',
  DROPPED_OFF: 'DROPPED_OFF',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
});

export const POOL_STOP_TYPE = Object.freeze({
  PICKUP: 'PICKUP',
  DROPOFF: 'DROPOFF',
});

export const POOL_STOP_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ARRIVED: 'ARRIVED',
  COMPLETED: 'COMPLETED',
  SKIPPED: 'SKIPPED',
});

export const POOL_EVENT_TYPE = Object.freeze({
  POOL_CREATED: 'POOL_CREATED',
  MEMBER_ADDED: 'MEMBER_ADDED',
  ROUTE_PLAN_CREATED: 'ROUTE_PLAN_CREATED',
  // Shared matching: a join was proposed for the pool, and a proposed plan was
  // adopted (which is also the moment the pool's version moves on).
  JOIN_PLAN_CREATED: 'JOIN_PLAN_CREATED',
  ROUTE_PLAN_UPDATED: 'ROUTE_PLAN_UPDATED',
  MEMBER_PICKED_UP: 'MEMBER_PICKED_UP',
  MEMBER_DROPPED_OFF: 'MEMBER_DROPPED_OFF',
  POOL_STATUS_CHANGED: 'POOL_STATUS_CHANGED',
  POOL_CANCELLED: 'POOL_CANCELLED',
});

export const POOL_ACTOR_TYPE = Object.freeze({
  PASSENGER: 'PASSENGER',
  DRIVER: 'DRIVER',
  SYSTEM: 'SYSTEM',
  ADMIN: 'ADMIN',
});

/**
 * The plan a single-passenger pool is created with: the passenger is picked up
 * first and dropped off second. A later milestone inserts further stops between
 * these, which is why the sequence is data rather than a constant.
 */
export const PICKUP_SEQUENCE = 1;
export const DROPOFF_SEQUENCE = 2;

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

/**
 * The deterministic score a candidate is ranked by.
 *
 *     score = approachDurationSeconds
 *           + rejectionPenaltySeconds        x rejections in the window
 *           + workloadPenaltySeconds         x offers accepted in the window
 *           - idleCredit (capped)
 *
 * Everything is in *seconds*, so the score is an integer with a clear meaning:
 * "the driver is this many seconds away, adjusted for how they have been
 * behaved and how long they have been waiting". The units are what makes the
 * weights configurable without becoming arbitrary multipliers.
 *
 * The idle credit is capped so a driver who has been idle for a week cannot
 * outrank a driver who is two minutes away -- fairness nudges the choice, it
 * does not override proximity.
 *
 * The straight-line distance the spatial shortlist used is deliberately NOT part
 * of the score: it decides who is worth routing, and the routed approach
 * duration decides who is best.
 */
export const candidateScore = ({
  approachDurationSeconds,
  recentRejections = 0,
  acceptedOffersRecently = 0,
  idleSeconds = 0,
  weights,
}) => {
  const idleCreditMinutes = Math.floor(Math.max(0, idleSeconds) / 60);
  const idleCredit = Math.min(
    weights.idleCreditMaxSeconds,
    idleCreditMinutes * weights.idleCreditPerMinuteSeconds,
  );

  const score =
    approachDurationSeconds +
    weights.rejectionPenaltySeconds * Math.max(0, recentRejections) +
    weights.workloadPenaltySeconds * Math.max(0, acceptedOffersRecently) -
    idleCredit;

  // A score is never negative: the database refuses one, and "better than
  // instantly here" is not a meaningful ranking.
  return Math.max(0, score);
};

/**
 * Candidate ordering: lowest score, then longest idle, then stable driver id.
 *
 * The third key is what makes dispatch reproducible: two identical candidates
 * are ordered by their profile id rather than by whatever order the database
 * returned, so the same situation always produces the same offer.
 */
export const compareCandidates = (a, b) => {
  if (a.score !== b.score) return a.score - b.score;

  const aIdle = a.availableSince ? new Date(a.availableSince).getTime() : 0;
  const bIdle = b.availableSince ? new Date(b.availableSince).getTime() : 0;
  if (aIdle !== bIdle) return aIdle - bIdle;

  return a.driverProfileId.localeCompare(b.driverProfileId);
};

/** The best candidate, or null when there is none. Does not mutate its input. */
export const bestCandidate = (candidates) =>
  candidates.length === 0 ? null : [...candidates].sort(compareCandidates)[0];

/**
 * The snapshot a driver is shown, and the only record of what they were offered.
 *
 * It carries what a driver needs to decide -- the two places, how far the
 * passenger is going, how far away the passenger is, and the vehicle -- and
 * nothing that identifies the passenger. Money is included only as the
 * passenger's own accepted solo fare, which the product already shows nobody but
 * the passenger; keeping it here would be a new disclosure, so it is not.
 */
export const buildProposalSnapshot = ({
  pickup,
  destination,
  approach,
  passengerRoute,
  vehicle,
  requestedAt,
}) => ({
  pickup: { code: pickup.code, name: pickup.name },
  destination: { code: destination.code, name: destination.name },
  approach: {
    // The point the approach was measured *from*. Acceptance compares it with
    // where the driver is now, so "you have moved since this offer was made" is
    // a fact rather than a guess.
    fromServicePointCode: approach.fromServicePointCode,
    distanceMeters: approach.distanceMeters,
    durationSeconds: approach.durationSeconds,
  },
  passengerRoute: {
    distanceMeters: passengerRoute.distanceMeters,
    durationSeconds: passengerRoute.durationSeconds,
  },
  vehicle: { name: vehicle.name, seatCapacity: vehicle.seatCapacity },
  requestedAt: new Date(requestedAt).toISOString(),
});
