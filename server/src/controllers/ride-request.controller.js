import { env } from '../config/env.js';
import { currentUser } from '../middleware/auth.js';
import * as dispatch from '../services/dispatch.service.js';
import * as rides from '../services/ride-request.service.js';
import * as dto from '../serializers/ride-request.serializer.js';
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

  // Dispatch runs *after* the creation transaction has committed, so the
  // passenger's response never waits on a routing search, and nothing that
  // happens here can roll the request back: a request with no offer is still a
  // valid request, and `npm run dispatch:sweep` -- or the next driver's refusal --
  // will offer it. It is awaited rather than fired and forgotten so the caller
  // learns whether the ride was offered, and so a test does not have to race it.
  if (!replay) {
    try {
      await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    } catch (err) {
      console.error(`[dispatch] could not offer ride request ${request.id}:`, err.message);
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

  res.json(dto.toRideRequestDto(request));
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
