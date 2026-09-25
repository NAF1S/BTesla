import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { requirePassengerProfileId } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { ACTIVE_RIDE_REQUEST_STATUSES, RIDE_REQUEST_STATUS } from './ride.status.js';

/**
 * The passenger's *read* model: the ride they are on now, their history, and one
 * ride in detail.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS FOR
 * ---------------------------------------------------------------------------
 * `ride-request.service.js` owns the ride-request *lifecycle* -- creating,
 * cancelling, expiring, and every status write in the project. This module owns
 * nothing: it is the read side, kept separate for the same reason the two have
 * different shapes. A lifecycle write is a locked transaction over one row; a
 * history read is a paged, filtered, joined projection over many. Mixing them
 * would mean the write path carried a projection it never uses.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP
 * ---------------------------------------------------------------------------
 * `passengerProfileId` is on every `where` clause in this file, and it always
 * comes from the authenticated user (`requirePassengerProfileId`) -- never from a
 * parameter. There is no function here that takes a passenger id, so "somebody
 * else's ride" is not an addressable resource: it is simply a row the query
 * cannot see, and the caller gets the same 404 an unknown id gets. A 403 would
 * confirm the id exists.
 *
 * ---------------------------------------------------------------------------
 * AVOIDING N+1
 * ---------------------------------------------------------------------------
 * A page of rides needs four things beyond the ride rows themselves: the two
 * service points (a join), the assigned driver and vehicle (a join), the quote's
 * rounding scale (a join), and the passenger's own shared fare (a second table).
 * All of the first three are resolved by Prisma inside the *single* `findMany`
 * that reads the page. The fourth is one additional query for the whole page,
 * not one per row -- see `loadFaresForRequests`. So the cost of a page is three
 * queries (count, page, fares) whatever the page size.
 */

/** Statuses that mean "this passenger is still on a journey". */
export const CURRENT_RIDE_STATUSES = Object.freeze([
  RIDE_REQUEST_STATUS.WAITING,
  RIDE_REQUEST_STATUS.MATCHED,
  RIDE_REQUEST_STATUS.IN_PROGRESS,
]);

const notFound = (rideRequestId) => new ApiError(404, `Ride "${rideRequestId}" was not found`);

/**
 * The driver's public summary, as a passenger may see it.
 *
 * A first name and a car. Not the driver's user id (which would be a handle on
 * their account), not their email, not their phone even if one existed, and not
 * the vehicle id. The `split` takes the first word, which is the same rule the
 * passenger's own trip DTO uses, so a passenger cannot see more about their
 * driver on one endpoint than on another.
 */
const DRIVER_SUMMARY_SELECT = {
  select: {
    user: { select: { name: true } },
  },
};

/**
 * Everything a ride summary needs, resolved inside the page query.
 *
 * `poolMember` is included as a *one-to-one* relation, so it costs nothing extra:
 * a request that has not been matched has none, which is exactly the "no driver
 * yet" state.
 */
const SUMMARY_SELECT = {
  id: true,
  status: true,
  requestedAt: true,
  startedAt: true,
  completedAt: true,
  cancelledAt: true,
  currency: true,
  acceptedFare: true,
  acceptedPricingCode: true,
  acceptedPricingVersion: true,
  acceptedDistanceMeters: true,
  acceptedDurationSeconds: true,
  pickupServicePoint: { select: { id: true, code: true, name: true } },
  dropoffServicePoint: { select: { id: true, code: true, name: true } },
  fareQuote: { select: { fareBreakdown: true } },
  poolMember: {
    select: {
      id: true,
      status: true,
      matchedAt: true,
      pickedUpAt: true,
      droppedOffAt: true,
      ridePool: {
        select: {
          id: true,
          status: true,
          capacitySnapshot: true,
          plannedDistanceMeters: true,
          plannedDurationSeconds: true,
          // Read for the passenger's `stage`: a passenger is `DRIVER_EN_ROUTE`
          // from the moment the car set off, and the only row that records that
          // is the pool's.
          departedAt: true,
          completedAt: true,
          vehicle: { select: { name: true, seatCapacity: true } },
          driverProfile: { select: DRIVER_SUMMARY_SELECT.select },
          // Aggregate only: how many people are sharing the car. The rows are not
          // read, so no other passenger's identity can reach the DTO even by
          // accident -- a count cannot be unpacked into a person.
          _count: { select: { members: true } },
        },
      },
    },
  },
};

/**
 * The passenger's own stops for one request, in the order they happen.
 *
 * One small indexed read (`pool_stops_ride_request_id_idx`). Filtered by the
 * *request*, which is what makes these the passenger's own stops rather than the
 * pool's plan: `pool_stops_pool_member_type_unique` guarantees there are at most
 * two, and both are theirs.
 */
const loadStopsForRequest = (rideRequestId) =>
  prisma.poolStop.findMany({
    where: { rideRequestId },
    orderBy: { sequence: 'asc' },
    select: {
      id: true,
      sequence: true,
      stopType: true,
      status: true,
      plannedArrivalAt: true,
      actualArrivalAt: true,
      completedAt: true,
      servicePoint: { select: { code: true, name: true } },
    },
  });

/**
 * The passenger's own shared fare for each of a page of requests, in one query.
 *
 * Ordered so the newest allocation for a request comes first, and collapsed to
 * one row per request. A request with no allocated fare (not matched yet) is
 * simply absent from the map, which the serializer reports as `null` rather than
 * as a zero.
 */
const loadFaresForRequests = async (rideRequestIds) => {
  if (rideRequestIds.length === 0) return new Map();

  const allocations = await prisma.passengerFareAllocation.findMany({
    where: { rideRequestId: { in: rideRequestIds } },
    orderBy: [{ rideRequestId: 'asc' }, { createdAt: 'desc' }],
    select: {
      rideRequestId: true,
      finalFare: true,
      acceptedSoloFare: true,
      currency: true,
      fareCalculation: {
        select: {
          status: true,
          poolVersion: true,
          finalizedAt: true,
          pricingPolicy: { select: { roundingScale: true } },
        },
      },
    },
  });

  const byRequest = new Map();
  for (const allocation of allocations) {
    // `orderBy createdAt desc` means the first row per request is the newest one.
    if (!byRequest.has(allocation.rideRequestId)) {
      byRequest.set(allocation.rideRequestId, allocation);
    }
  }

  return byRequest;
};

/**
 * The ride the passenger is on right now.
 *
 * "Now" is the passenger's single active slot: the database allows at most one
 * request in WAITING, MATCHED or IN_PROGRESS (`one_active_ride_request_per_passenger`),
 * so this reads at most one row and the ordering is a belt-and-braces tie-break
 * rather than a choice among candidates.
 *
 * Returns null when there is none. Null is not an error and it is not a 404: an
 * available passenger has no ride, and so does one whose last ride finished a
 * minute ago. The endpoint answers 200 with `ride: null`, the same way the
 * driver's current-pool endpoint answers with a null pool.
 */
export const getCurrentRide = async ({ passenger }) => {
  const passengerProfileId = requirePassengerProfileId(passenger);

  const request = await prisma.rideRequest.findFirst({
    where: { passengerProfileId, status: { in: CURRENT_RIDE_STATUSES } },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    select: SUMMARY_SELECT,
  });

  if (!request) return null;

  // The passenger's own two stops, for the stage and for the "where is the car"
  // tracker. Filtered by this request, so a co-passenger's stops are never read;
  // a request with no member has none, and the read is skipped entirely.
  const stops = request.poolMember ? await loadStopsForRequest(request.id) : [];
  const fares = await loadFaresForRequests([request.id]);

  return { request, fare: fares.get(request.id) ?? null, stops };
};

/**
 * The passenger's history: newest first, filterable, paged.
 *
 * Ordering is `requestedAt DESC, id DESC`. The tie-breaker is not decoration: two
 * requests made in the same millisecond -- which a test can create on purpose and
 * a busy system can create by accident -- would otherwise come back in whatever
 * order the planner chose, and a client paging through them would see one twice
 * and another never. With the id appended the order is total, so page N+1 starts
 * exactly where page N stopped.
 */
export const listRidesForPassenger = async ({
  passenger,
  status = null,
  from = null,
  to = null,
  limit = env.rideRequests.historyPageSize,
  offset = 0,
}) => {
  const passengerProfileId = requirePassengerProfileId(passenger);

  const requestedAt = {};
  if (from) requestedAt.gte = from;
  if (to) requestedAt.lte = to;

  const where = {
    passengerProfileId,
    ...(status ? { status } : {}),
    ...(from || to ? { requestedAt } : {}),
  };

  const total = await prisma.rideRequest.count({ where });

  const requests = await prisma.rideRequest.findMany({
    where,
    select: SUMMARY_SELECT,
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    skip: offset,
    take: limit,
  });

  // One query for the whole page. Doing this per row is the N+1 this projection
  // exists to avoid.
  const fares = await loadFaresForRequests(requests.map((request) => request.id));

  return {
    rides: requests.map((request) => ({ request, fare: fares.get(request.id) ?? null })),
    total,
    limit,
    offset,
  };
};

/**
 * One ride, in detail, but only if it is this passenger's.
 *
 * The detail adds three things a summary does not have: the passenger's own stops,
 * their own lifecycle timeline, and their fare breakdown. Each is read for *this*
 * request alone, so the note above about a page's query count does not apply --
 * there is one ride, and four small indexed reads.
 *
 * The stops are filtered to this passenger's own member row, which is what makes
 * "your pickup and your drop-off" true rather than "the pool's stops". A
 * co-passenger's stops are never read into this response at all.
 */
export const findRideForPassenger = async ({ passenger, rideRequestId }) => {
  const passengerProfileId = requirePassengerProfileId(passenger);

  // Ownership is part of the read, not a check afterwards. A request that belongs
  // to somebody else is not found, which is the same answer an unknown id gets.
  const request = await prisma.rideRequest.findFirst({
    where: { id: rideRequestId, passengerProfileId },
    select: { ...SUMMARY_SELECT, searchExpiresAt: true, cancellationReason: true },
  });

  if (!request) throw notFound(rideRequestId);

  // Sequential rather than `Promise.all`, for the reason `listRideRequestsForPassenger`
  // gives: the PostgreSQL adapter prefers one statement at a time on a connection,
  // and three small indexed reads are not worth racing for.
  const events = await prisma.rideEvent.findMany({
    where: { rideRequestId },
    orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    // `metadata` and `actorUserId` are deliberately not selected: the timeline
    // mapper could not read them even if it wanted to.
    select: { id: true, sequence: true, eventType: true, actorType: true, createdAt: true },
  });

  const stops = request.poolMember ? await loadStopsForRequest(request.id) : [];

  const fares = await loadFaresForRequests([rideRequestId]);

  return {
    request,
    fare: fares.get(rideRequestId) ?? null,
    stops,
    events,
  };
};
