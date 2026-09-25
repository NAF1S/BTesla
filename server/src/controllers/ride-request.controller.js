import { env } from '../config/env.js';
import { currentUser } from '../middleware/auth.js';
import * as assignment from '../services/assignment.service.js';
import * as poolFares from '../services/pool-fare.service.js';
import * as rides from '../services/ride-request.service.js';
import * as trips from '../services/trip.service.js';
import { ApiError } from '../utils/ApiError.js';
import * as dto from '../serializers/ride-request.serializer.js';
import { toPassengerFareDto } from '../serializers/pool-fare.serializer.js';
import { CANCELLATION_REASONS, DEFAULT_CANCELLATION_REASON, RIDE_REQUEST_STATUSES } from '../services/ride.status.js';
import {
  assertBodyKeys,
  assertQueryKeys,
  optionalEnumValue,
  requireBoundedInteger,
  requireIdempotencyKey,
  requireUuid,
} from '../utils/validation.js';

/**
 * Passenger ride-request endpoints.
 *
 * Authorization is the existing one: `requireAuth` loads the user from the
 * database and `requireRole(PASSENGER)` keeps drivers out. The passenger is then
 * taken from that record, never from the request, so there is no field a client
 * could use to act as somebody else.
 *
 * What a client cannot supply, and what happens if it tries:
 *
 *   * `passengerId` / `passengerProfileId` -- unsupported body field, 400;
 *   * `fare`, `currency`, `distanceMeters`, `durationSeconds`, `pricingCode`,
 *     `pricingVersion` -- unsupported body field, 400 (all of them are copied
 *     from the quote server-side);
 *   * `status` -- unsupported body field, 400; no endpoint sets a status
 *     directly, and the two operations that change one are cancel and expire;
 *   * `requestFingerprint` -- unsupported body field, 400. It is computed from
 *     the quote and the authenticated passenger.
 *
 * Status-code convention:
 *   201 - a ride request was created
 *   200 - an idempotent retry returned the request that already existed
 *   400 - malformed request (bad quote id, bad key, unknown field or filter)
 *   401 - no valid authentication
 *   403 - authenticated, but not a passenger
 *   404 - unknown, expired-away, or somebody else's quote or request
 *   409 - the request could not be created or cancelled from the current state
 *   500 - an unexpected failure; never a raw SQL or driver message
 */

const CREATE_BODY_KEYS = ['fareQuoteId'];
const CANCEL_BODY_KEYS = ['reason'];
const LIST_QUERY_KEYS = ['status', 'limit', 'offset'];

export const createRideRequest = async (req, res) => {
  const body = req.body ?? {};
  assertBodyKeys(body, CREATE_BODY_KEYS);

  const fareQuoteId = requireUuid(body.fareQuoteId, 'fareQuoteId');
  const idempotencyKey = requireIdempotencyKey(req.get('Idempotency-Key'));

  const { request, replay } = await rides.createRideRequest({
    passenger: currentUser(req),
    fareQuoteId,
    idempotencyKey,
  });

  // Assignment runs *after* the creation transaction has committed, so the
  // passenger's response never waits on a routing search, and nothing that
  // happens here can roll the request back: a request with no offer is still a
  // valid request, and `npm run dispatch:sweep` -- or the next driver's refusal --
  // will assign it. It is awaited rather than fired and forgotten so the caller
  // learns whether the ride was offered, and so a test does not have to race it.
  //
  // This is the orchestrator rather than the dispatcher: a new request tries to
  // join a pool that is already forming first, and only falls back to finding a
  // driver of its own.
  if (!replay) {
    try {
      await assignment.assignWaitingRequest({ rideRequestId: request.id });
    } catch (err) {
      console.error(`[assignment] could not assign ride request ${request.id}:`, err.message);
    }
  }

  // A retry returns the request the first call created; nothing new was made, so
  // it is a 200 rather than a second 201.
  res.status(replay ? 200 : 201).json(dto.toRideRequestDto(request));
};

export const getRideRequest = async (req, res) => {
  const rideRequestId = requireUuid(req.params.id, 'id');

  const request = await rides.findRideRequestForPassenger({
    passenger: currentUser(req),
    rideRequestId,
  });

  // The passenger's own trip, if they have been matched: who is driving, where
  // the car is, and what has happened to *their* ride. Only their own member,
  // stops and events are read, so a passenger cannot be shown another's part of
  // the pool. The history page deliberately leaves this out (see the serializer).
  const trip = await trips.loadPassengerTrip(rideRequestId);

  res.json(dto.toRideRequestDto(request, { trip }));
};

export const listMyRideRequests = async (req, res) => {
  assertQueryKeys(req.query, LIST_QUERY_KEYS);

  const status = optionalEnumValue(req.query.status, RIDE_REQUEST_STATUSES, 'status');
  const limit = requireBoundedInteger(req.query.limit, 'limit', {
    fallback: env.rideRequests.historyPageSize,
    min: 1,
    max: env.rideRequests.historyMaxPageSize,
  });
  const offset = requireBoundedInteger(req.query.offset, 'offset', {
    fallback: 0,
    min: 0,
    max: 1_000_000,
  });

  const page = await rides.listRideRequestsForPassenger({
    passenger: currentUser(req),
    status,
    limit,
    offset,
  });

  res.json(dto.toRideRequestListDto(page));
};

export const cancelRideRequest = async (req, res) => {
  const rideRequestId = requireUuid(req.params.id, 'id');

  const body = req.body ?? {};
  assertBodyKeys(body, CANCEL_BODY_KEYS);

  const reason =
    optionalEnumValue(body.reason, CANCELLATION_REASONS, 'reason') ??
    DEFAULT_CANCELLATION_REASON;

  const request = await rides.cancelRideRequest({
    passenger: currentUser(req),
    rideRequestId,
    reason,
  });

  res.json(dto.toRideRequestDto(request));
};

/**
 * The fare this passenger is currently being charged for one of their requests.
 *
 * `GET /ride-requests/:id/fare` answers 404 when there is no shared fare to
 * report -- before a request is matched, and for the moment around a match before
 * its calculation is written. Empty is a 404 here, not a zero: a passenger who is
 * not sharing anything has an accepted solo fare (visible on the request itself),
 * and reporting "0.00" would be inventing an answer.
 *
 * The ownership check is the same one `GET /ride-requests/:id` uses, and somebody
 * else's request is a 404 rather than a 403, so this cannot be used to discover
 * which request ids exist. There is deliberately no route that takes a pool id: a
 * passenger cannot ask about a pool, and therefore cannot ask about the people in
 * it.
 */
export const getRideRequestFare = async (req, res) => {
  const rideRequestId = requireUuid(req.params.id, 'id');

  // Throws 404 unless the request is the caller's own.
  await rides.findRideRequestForPassenger({ passenger: currentUser(req), rideRequestId });

  const fare = await poolFares.loadCurrentFareForRequest({ rideRequestId });

  if (!fare) {
    throw new ApiError(404, 'No shared fare has been calculated for this ride request yet');
  }

  res.json(toPassengerFareDto({ rideRequestId, ...fare }));
};
