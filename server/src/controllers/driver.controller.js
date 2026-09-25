import { env } from '../config/env.js';
import { currentUser } from '../middleware/auth.js';
import * as assignment from '../services/assignment.service.js';
import * as drivers from '../services/driver.service.js';
import * as offers from '../services/offer.service.js';
import { toDriverAvailabilityDto } from '../serializers/driver.serializer.js';
import { toPoolDto } from '../serializers/pool.serializer.js';
import { OFFER_STATUSES, REJECTION_REASONS } from '../services/dispatch.rules.js';
import {
  assertBodyKeys,
  assertQueryKeys,
  optionalEnumValue,
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
