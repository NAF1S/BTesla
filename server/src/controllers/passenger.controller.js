import { env } from '../config/env.js';
import { currentUser } from '../middleware/auth.js';
import * as passengerRides from '../services/passenger-ride.service.js';
import { RIDE_REQUEST_STATUSES } from '../services/ride.status.js';
import * as dto from '../serializers/passenger-ride.serializer.js';
import {
  assertQueryKeys,
  optionalEnumValue,
  optionalIsoTimestamp,
  requireBoundedInteger,
  requireUuid,
} from '../utils/validation.js';

/**
 * The passenger's read APIs: the ride they are on, their history, one ride.
 *
 * These are the endpoints a passenger app is built on, and they are all reads:
 * nothing here changes a ride. The writes live next to the state machines that
 * own them (`POST /ride-requests`, `POST /ride-requests/:id/cancel`), so a client
 * cannot reach a status change through the history API, however it shapes the
 * query string.
 *
 * ---------------------------------------------------------------------------
 * WHOSE DATA IS THIS
 * ---------------------------------------------------------------------------
 * `requireAuth` + `requireRole(PASSENGER)` reject an anonymous caller and a
 * driver. The passenger is then taken from the authenticated user record, and
 * every query in `passenger-ride.service.js` filters on that profile id. There is
 * no passenger id in a path, a query string or a body anywhere in this file, so
 * "read somebody else's history" is not a request that can be expressed. The one
 * identifier a client *does* send -- a ride-request id -- is checked against the
 * caller's own rows, and a ride that is not theirs is a 404, not a 403: a 403
 * would confirm the id exists.
 *
 * ---------------------------------------------------------------------------
 * WHY UNKNOWN QUERY PARAMETERS ARE REJECTED
 * ---------------------------------------------------------------------------
 * `assertQueryKeys` turns `?passengerId=…` into a 400 rather than silently
 * ignoring it. That is the same reasoning as the ownership check: a client should
 * learn that this API does not work that way, and a reader of the code should not
 * have to wonder whether an ignored parameter was meant to do something.
 *
 * Status-code convention:
 *   200 - the read succeeded, including the empty history and the "no current
 *         ride" answer (`ride: null`)
 *   400 - malformed request: bad uuid, unknown status, unknown query parameter,
 *         or a date range that cannot be parsed
 *   401 - no valid authentication
 *   403 - authenticated, but not a passenger
 *   404 - no such ride, or a ride that is not this passenger's
 *   500 - an unexpected failure; never a raw SQL or driver message
 */

const HISTORY_QUERY_KEYS = ['status', 'from', 'to', 'limit', 'offset'];

export const getCurrentRide = async (req, res) => {
  // No query parameters at all: this endpoint always answers about the caller's
  // single active ride, and there is nothing to filter.
  assertQueryKeys(req.query, []);

  const ride = await passengerRides.getCurrentRide({ passenger: currentUser(req) });

  res.json(dto.toCurrentRideEnvelope(ride));
};

export const listMyRides = async (req, res) => {
  assertQueryKeys(req.query, HISTORY_QUERY_KEYS);

  // `status` is optional and validated against the real enum, so a typo is a 400
  // rather than an empty page that looks like "you have never ridden".
  const status = optionalEnumValue(req.query.status, RIDE_REQUEST_STATUSES, 'status');
  const from = optionalIsoTimestamp(req.query.from, 'from');
  const to = optionalIsoTimestamp(req.query.to, 'to');

  const page = await passengerRides.listRidesForPassenger({
    passenger: currentUser(req),
    status,
    from,
    to,
    limit: requireBoundedInteger(req.query.limit, 'limit', {
      fallback: env.rideRequests.historyPageSize,
      min: 1,
      max: env.rideRequests.historyMaxPageSize,
    }),
    offset: requireBoundedInteger(req.query.offset, 'offset', {
      fallback: 0,
      min: 0,
      max: 1_000_000,
    }),
  });

  res.json(dto.toRideHistoryDto(page));
};

export const getMyRide = async (req, res) => {
  const rideRequestId = requireUuid(req.params.rideRequestId, 'rideRequestId');

  const ride = await passengerRides.findRideForPassenger({
    passenger: currentUser(req),
    rideRequestId,
  });

  res.json(dto.toRideDetailDto(ride));
};
