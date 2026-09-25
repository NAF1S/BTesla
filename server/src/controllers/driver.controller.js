import { env } from '../config/env.js';
import { currentUser } from '../middleware/auth.js';
import * as assignment from '../services/assignment.service.js';
import * as drivers from '../services/driver.service.js';
import * as history from '../services/driver-history.service.js';
import * as offers from '../services/offer.service.js';
import { loadPoolForDto } from '../services/pool.service.js';
import * as trips from '../services/trip.service.js';
import { ApiError } from '../utils/ApiError.js';
import { toDriverAvailabilityDto } from '../serializers/driver.serializer.js';
import {
  toDriverRideDetailDto,
  toDriverRideHistoryDto,
} from '../serializers/driver-ride.serializer.js';
import { toPoolDto } from '../serializers/pool.serializer.js';
import { OFFER_STATUSES, POOL_STATUSES, REJECTION_REASONS } from '../services/dispatch.rules.js';
import {
  assertBodyKeys,
  assertQueryKeys,
  optionalCode,
  optionalEnumValue,
  optionalIsoTimestamp,
  requireBoundedInteger,
  requireCode,
  requireUuid,
} from '../utils/validation.js';

/**
 * Driver availability and dispatch endpoints.
 *
 * Authorization is the existing one: `requireAuth` loads the user from the
 * database and `requireRole(DRIVER)` keeps passengers out, and the driver is then
 * taken from that record rather than from the request. Every operation on
 * "me" is therefore the authenticated driver's own profile; there is no route,
 * body field or query parameter anywhere in this file that names a driver, so
 * there is nothing a client could tamper with to act as somebody else.
 *
 * The only identifier a client may send is an *offer* id, and an offer that
 * belongs to another driver is a 404 -- the same answer as an offer that does not
 * exist, so this cannot be used to discover other drivers' work.
 *
 * Status-code convention:
 *   200 - the operation succeeded (go online, go offline, move, answer, read)
 *   201 - no driver endpoint creates a resource of its own; acceptance returns
 *         the pool it created as a 200, because the pool belongs to the offer
 *   400 - malformed request: bad code, bad uuid, unknown field or filter
 *   401 - no valid authentication
 *   403 - authenticated, but not a driver (or a driver with no profile)
 *   404 - unknown offer, or an offer that is not this driver's
 *   409 - the operation conflicts with the current state: no vehicle, inactive
 *         service point, already reserved, offer expired or already answered,
 *         already in a pool, vehicle deactivated
 *   500 - an unexpected failure; never a raw SQL or driver message
 */

const ONLINE_BODY_KEYS = ['currentServicePointCode', 'vehicleId'];
const CURRENT_POINT_BODY_KEYS = ['currentServicePointCode'];
const REJECT_BODY_KEYS = ['reason'];
const LIST_QUERY_KEYS = ['status', 'limit'];
const HISTORY_QUERY_KEYS = ['status', 'from', 'to', 'limit', 'offset'];

/**
 * The one availability write: `online`, and where to come online at.
 *
 * `operationalStatus` and `status` are deliberately absent. A client says whether
 * it is online and nothing more; `RESERVED` and `ON_RIDE` are facts the dispatch
 * and trip code establish by accepting a ride and departing, and a device that
 * could set them could make itself dispatchable while carrying a passenger.
 * Sending either is a 400 from `assertBodyKeys`, not a silent no-op.
 */
const AVAILABILITY_BODY_KEYS = ['online', 'servicePointId', 'servicePointCode', 'vehicleId'];

/** An optional UUID, so "not supplied" is distinguishable from "malformed". */
const optionalUuid = (value, field) =>
  value === undefined || value === null ? null : requireUuid(value, field);

export const getAvailability = async (req, res) => {
  // No query parameters, and saying so is the point: a typo like
  // `?driverProfileId=` must surface as a 400 rather than being ignored, and it
  // is also what makes "this endpoint cannot address another driver" true of the
  // query string as well as of the body.
  assertQueryKeys(req.query, []);

  const profile = await drivers.getAvailability({ driver: currentUser(req) });

  res.json(toDriverAvailabilityDto(profile));
};

/**
 * The unified availability write: `{ online: true|false, … }`.
 *
 * Going online needs a place to be, and it may be named either way: `servicePointCode`
 * (a stable code, which is what the rest of the API uses for a place) or
 * `servicePointId` (a uuid, for a client that already holds the location row).
 * Naming both is a 400 rather than a precedence rule, because two answers to one
 * question is a bug in the caller and guessing which they meant is how a driver
 * ends up reporting the wrong corner.
 *
 * Going offline needs no place: a driver who is offline is not anywhere as far as
 * dispatch is concerned.
 */
export const setAvailability = async (req, res) => {
  const body = req.body ?? {};
  assertBodyKeys(body, AVAILABILITY_BODY_KEYS);

  if (typeof body.online !== 'boolean') {
    throw new ApiError(400, 'online must be true or false');
  }

  if (body.servicePointId !== undefined && body.servicePointCode !== undefined) {
    throw new ApiError(400, 'Send either servicePointId or servicePointCode, not both');
  }

  const currentServicePointCode = optionalCode(body.servicePointCode, 'servicePointCode');
  const currentServicePointId = optionalUuid(body.servicePointId, 'servicePointId');

  if (body.online && !currentServicePointCode && !currentServicePointId) {
    throw new ApiError(400, 'servicePointCode or servicePointId is required to go online');
  }

  const profile = await drivers.setAvailability({
    driver: currentUser(req),
    online: body.online,
    currentServicePointCode,
    currentServicePointId,
    vehicleId: optionalUuid(body.vehicleId, 'vehicleId'),
  });

  res.json(toDriverAvailabilityDto(profile));
};

export const goOnline = async (req, res) => {
  const body = req.body ?? {};
  assertBodyKeys(body, ONLINE_BODY_KEYS);

  const profile = await drivers.goOnline({
    driver: currentUser(req),
    currentServicePointCode: requireCode(body.currentServicePointCode, 'currentServicePointCode'),
    // Optional: a driver with one vehicle does not have to name it, and a driver
    // with several must. Never selects a vehicle the driver did not choose.
    vehicleId: optionalUuid(body.vehicleId, 'vehicleId'),
  });

  res.json(toDriverAvailabilityDto(profile));
};

export const goOffline = async (req, res) => {
  const body = req.body ?? {};
  assertBodyKeys(body, []);

  const profile = await drivers.goOffline({ driver: currentUser(req) });

  res.json(toDriverAvailabilityDto(profile));
};

export const setCurrentServicePoint = async (req, res) => {
  const body = req.body ?? {};
  assertBodyKeys(body, CURRENT_POINT_BODY_KEYS);

  const profile = await drivers.setCurrentServicePoint({
    driver: currentUser(req),
    currentServicePointCode: requireCode(body.currentServicePointCode, 'currentServicePointCode'),
  });

  res.json(toDriverAvailabilityDto(profile));
};

export const listOffers = async (req, res) => {
  assertQueryKeys(req.query, LIST_QUERY_KEYS);

  // Defaults to the offers a driver can still act on; `status=ALL` asks for the
  // whole history.
  const status =
    req.query.status === undefined
      ? 'PENDING'
      : optionalEnumValue(req.query.status, [...OFFER_STATUSES, 'ALL'], 'status');

  const limit = requireBoundedInteger(req.query.limit, 'limit', {
    fallback: env.dispatch.listPageSize,
    min: 1,
    max: 100,
  });

  const page = await offers.listOffersForDriver({
    driver: currentUser(req),
    status: status ?? 'PENDING',
    limit,
  });

  res.json({ data: page });
};

export const getOffer = async (req, res) => {
  const offer = await offers.findOfferForDriver({
    driver: currentUser(req),
    offerId: requireUuid(req.params.offerId, 'offerId'),
  });

  res.json(offer);
};

export const acceptOffer = async (req, res) => {
  const body = req.body ?? {};
  assertBodyKeys(body, []);

  const { pool } = await offers.acceptOffer({
    driver: currentUser(req),
    offerId: requireUuid(req.params.offerId, 'offerId'),
  });

  res.json(toPoolDto(pool));
};

export const rejectOffer = async (req, res) => {
  const body = req.body ?? {};
  assertBodyKeys(body, REJECT_BODY_KEYS);

  const reason = optionalEnumValue(body.reason, REJECTION_REASONS, 'reason');

  const outcome = await offers.rejectOffer({
    driver: currentUser(req),
    offerId: requireUuid(req.params.offerId, 'offerId'),
    ...(reason ? { reason } : {}),
  });

  // The request is waiting again, so the orchestrator gets it: the pool that just
  // refused is excluded, another compatible pool may be tried, and a driver of
  // their own is found if none can take it. The rejection is already committed at
  // this point, and an assignment failure cannot undo it: the sweep will pick the
  // request up.
  try {
    await assignment.assignWaitingRequest({ rideRequestId: outcome.rideRequestId });
  } catch (err) {
    console.error(
      `[assignment] could not re-assign ride request ${outcome.rideRequestId}:`,
      err.message,
    );
  }

  res.json({
    offerId: outcome.offerId,
    offerType: outcome.offerType,
    status: 'REJECTED',
    rejectionReason: outcome.reason,
    rideRequestId: outcome.rideRequestId,
    ridePoolId: outcome.ridePoolId,
  });
};

export const getCurrentPool = async (req, res) => {
  assertQueryKeys(req.query, []);

  const pool = await offers.getCurrentPoolForDriver({ driver: currentUser(req) });

  // No pool is not an error: an available driver has none, and so does a driver
  // whose trip has finished.
  res.json({ pool: toPoolDto(pool) });
};

/**
 * The trip commands: depart, arrive, pick up, start, drop off, complete.
 *
 * Every one takes no body at all, and every identifier is in the path. That is
 * deliberate: a trip command says "this happened", and there is nothing a client
 * could usefully add -- a timestamp, a seat count, a driver or an amount sent in
 * a body would all be something to validate, or worse, to trust. `assertBodyKeys`
 * with no allowed keys makes a supplied field a 400 rather than a silent no-op.
 *
 * Idempotency is state, not a key: sending the same command twice returns the
 * state it produced the first time, with no second event and no timestamp moved.
 * The service decides that; see trip.service.js.
 */
const readPoolId = (req) => requireUuid(req.params.poolId, 'poolId');

/**
 * Runs one trip command and answers with the pool as it now stands.
 *
 * The response is read back by pool id rather than from "the driver's active
 * pool": completing a trip is exactly the operation that stops the pool being
 * active, and the driver still has to be told how it ended. Idempotent retries
 * answer the same way, which is what makes a retry indistinguishable from the
 * first success.
 */
const runTripCommand = async (req, res, work) => {
  const body = req.body ?? {};
  assertBodyKeys(body, []);

  const { ridePoolId } = await work();

  const pool = await loadPoolForDto(ridePoolId);
  if (!pool) throw new ApiError(404, `Ride pool "${ridePoolId}" was not found`);

  res.json({ pool: toPoolDto(pool) });
};

export const departPool = async (req, res) =>
  runTripCommand(req, res, async () => {
    const { outcome, ridePoolId } = await trips.departPool({
      driver: currentUser(req),
      ridePoolId: readPoolId(req),
    });

    // The passengers whose join offers the departure cancelled are waiting again.
    // The departure is already committed, so this is an orchestration step, not
    // part of it: if there is no driver or pool to offer them, the dispatcher
    // sweep picks them up rather than the departure failing.
    for (const rideRequestId of outcome.releasedRequestIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await assignment.assignWaitingRequest({ rideRequestId });
      } catch (err) {
        console.error(
          `[assignment] could not re-assign ride request ${rideRequestId} after a departure:`,
          err.message,
        );
      }
    }

    return { ridePoolId, applied: outcome.applied };
  });

export const arriveAtStop = async (req, res) =>
  runTripCommand(req, res, () =>
    trips.arriveAtStop({
      driver: currentUser(req),
      ridePoolId: readPoolId(req),
      stopId: requireUuid(req.params.stopId, 'stopId'),
    }),
  );

export const pickUpMember = async (req, res) =>
  runTripCommand(req, res, () =>
    trips.pickUpMember({
      driver: currentUser(req),
      ridePoolId: readPoolId(req),
      stopId: requireUuid(req.params.stopId, 'stopId'),
      memberId: requireUuid(req.params.memberId, 'memberId'),
    }),
  );

export const startTrip = async (req, res) =>
  runTripCommand(req, res, () =>
    trips.startTrip({ driver: currentUser(req), ridePoolId: readPoolId(req) }),
  );

export const dropOffMember = async (req, res) =>
  runTripCommand(req, res, () =>
    trips.dropOffMember({
      driver: currentUser(req),
      ridePoolId: readPoolId(req),
      stopId: requireUuid(req.params.stopId, 'stopId'),
      memberId: requireUuid(req.params.memberId, 'memberId'),
    }),
  );

export const completeTrip = async (req, res) =>
  runTripCommand(req, res, () =>
    trips.completeTrip({ driver: currentUser(req), ridePoolId: readPoolId(req) }),
  );

/**
 * The driver's own ride history: the pools they have driven.
 *
 * The unit is a pool, not a ride request: a pool is one car's journey, and a
 * driver who carried three passengers drove one trip, not three. `?status=`
 * filters on the real pool statuses, and `?from=`/`?to=` are an inclusive range
 * on `createdAt` -- the instant the pool was accepted, which is the only pool
 * timestamp that is never null.
 *
 * The list is paged like every other list in this project: `limit`/`offset` with
 * a `pagination` block, ordered `createdAt DESC, id DESC` so that two pools
 * accepted in the same millisecond still have one fixed order to page through.
 */
export const listMyRides = async (req, res) => {
  assertQueryKeys(req.query, HISTORY_QUERY_KEYS);

  const page = await history.listRidesForDriver({
    driver: currentUser(req),
    status: optionalEnumValue(req.query.status, POOL_STATUSES, 'status'),
    from: optionalIsoTimestamp(req.query.from, 'from'),
    to: optionalIsoTimestamp(req.query.to, 'to'),
    limit: requireBoundedInteger(req.query.limit, 'limit', {
      fallback: env.dispatch.listPageSize,
      min: 1,
      max: 100,
    }),
    offset: requireBoundedInteger(req.query.offset, 'offset', {
      fallback: 0,
      min: 0,
      max: 1_000_000,
    }),
  });

  res.json(toDriverRideHistoryDto(page));
};

/**
 * One of the driver's own pools, in detail.
 *
 * Another driver's pool is a 404, not a 403: a 403 would tell one driver that
 * another driver's pool id is real, and that is not something a client has any
 * reason to learn.
 */
export const getMyRide = async (req, res) => {
  const ride = await history.findRideForDriver({
    driver: currentUser(req),
    ridePoolId: requireUuid(req.params.poolId, 'poolId'),
  });

  res.json(toDriverRideDetailDto(ride));
};
