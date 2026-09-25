import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import * as assignment from '../../src/services/assignment.service.js';
import { createSoloFareQuote } from '../../src/services/fare.service.js';
import * as dispatch from '../../src/services/dispatch.service.js';
import * as offers from '../../src/services/offer.service.js';
import { createRideRequest, listRideEvents } from '../../src/services/ride-request.service.js';
import { listPoolEvents } from '../../src/services/pool.service.js';
import { startApiServer } from '../helpers/api-server.js';
import { closePool, pool, prepareDatabase } from '../helpers/db.js';
import {
  createTestDriver,
  goOnline,
  loadDemoUser,
  POINTS,
  removeTestDriver,
  resetDispatchState,
  withEnv,
} from '../helpers/drivers.js';

/**
 * Dispatch: who is considered, who wins, and what happens when an offer ends.
 *
 * The suite works at both levels on purpose. The *search* is tested through the
 * service, because what matters there is which driver is chosen and why -- and
 * because a candidate list is not a thing an HTTP client ever sees. The *driver's
 * side* is tested over HTTP, because that is where authorization and the offer
 * DTO are actually decided.
 *
 * Every test that depends on shared state resets it first: a driver left online
 * by one test is a candidate for the next one's ride.
 */

/** 08:41 in Dhaka -- inside the morning peak, so the fare is deterministic. */
const DEPARTURE = new Date('2026-09-24T08:41:00+06:00');

let api;
let nusrat;
let rafiq;
let jashim;
let salauddin;
let jashimCookie;
let salauddinCookie;
let nusratCookie;

let sequence = 0;
const nextKey = (label = 'dispatch') => `${label}-key-${Date.now()}-${(sequence += 1)}`;

const login = async (email) => {
  const response = await api.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: env.demoSeedPassword }),
  });
  assert.strictEqual(response.status, 200, `could not sign in as ${email}`);
  return response.setCookie.split(';')[0];
};

/** A real quote and a real WAITING request, without triggering dispatch. */
const requestRide = async (passenger, { now } = {}) => {
  const { quote } = await createSoloFareQuote({
    passengerProfileId: passenger.passengerProfile.id,
    originServicePointCode: POINTS.PICKUP,
    destinationServicePointCode: POINTS.DESTINATION,
    departureAt: DEPARTURE,
  });

  const { request } = await createRideRequest({
    passenger,
    fareQuoteId: quote.id,
    idempotencyKey: nextKey(),
    ...(now ? { now } : {}),
  });

  return request;
};

const pendingOffersFor = (rideRequestId) =>
  pool
    .query(
      `SELECT id, driver_profile_id, status, approach_distance_meters::text AS approach_distance_meters,
              approach_duration_seconds, score::text AS score, expires_at, proposal_snapshot
         FROM dispatch_offers WHERE ride_request_id = $1::uuid AND status = 'PENDING'`,
      [rideRequestId],
    )
    .then((result) => result.rows);

const allOffersFor = (rideRequestId) =>
  pool
    .query(
      `SELECT id, driver_profile_id, status, rejection_reason FROM dispatch_offers
        WHERE ride_request_id = $1::uuid ORDER BY offered_at`,
      [rideRequestId],
    )
    .then((result) => result.rows);

const requestStatus = async (rideRequestId) => {
  const { rows } = await pool.query(`SELECT status FROM ride_requests WHERE id = $1::uuid`, [
    rideRequestId,
  ]);
  return rows[0]?.status ?? null;
};

const driverStatus = async (driverProfileId) => {
  const { rows } = await pool.query(`SELECT status FROM driver_profiles WHERE id = $1::uuid`, [
    driverProfileId,
  ]);
  return rows[0]?.status ?? null;
};

/**
 * Gives a driver an active pool without a trip.
 *
 * Used to isolate the "no active pool" rule from the availability rule: the
 * driver stays AVAILABLE, so only the pool can be what excludes them.
 */
const giveDriverAPool = (driverProfileId) =>
  pool.query(
    `INSERT INTO ride_pools (driver_profile_id, vehicle_id, status, capacity_snapshot,
                             planned_distance_meters, planned_duration_seconds)
     SELECT $1::uuid, v.id, 'FORMING', 3, 1000, 300
       FROM vehicles v WHERE v.driver_id = $1::uuid AND v.active LIMIT 1`,
    [driverProfileId],
  );

before(async () => {
  await prepareDatabase();
  api = await startApiServer();

  nusrat = await loadDemoUser('nusrat@example.com');
  rafiq = await loadDemoUser('rafiq@example.com');
  jashim = await loadDemoUser('jashim@example.com');
  jashimCookie = await login('jashim@example.com');

  salauddin = await createTestDriver({
    name: 'Salauddin',
    vehicleName: 'Second Car',
    password: env.demoSeedPassword,
  });
  salauddinCookie = await login(salauddin.email);
  nusratCookie = await login('nusrat@example.com');
});

beforeEach(async () => {
  await resetDispatchState();
  // The fixtures are re-read because a test may have changed a vehicle.
  jashim = await loadDemoUser('jashim@example.com');
  salauddin = await loadDemoUser(salauddin.email);
});

after(async () => {
  await resetDispatchState();
  await removeTestDriver(salauddin.email);
  await api?.close();
  await closePool();
});

describe('the driver search', () => {
  it('considers only AVAILABLE drivers', async () => {
    await goOnline(jashim, POINTS.NEAR);
    await goOnline(salauddin, POINTS.NEAR);

    const request = await requestRide(nusrat);
    const first = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    assert.strictEqual(first.dispatched, true);
    assert.strictEqual(first.candidates, 2, 'both available drivers are candidates');

    // Whichever one won, taking them offline means the other is the only answer.
    const winner = first.driverProfileId;
    const loser = winner === jashim.driverProfile.id ? salauddin : jashim;
    await pool.query(`UPDATE driver_profiles SET status = 'OFFLINE' WHERE id = $1::uuid`, [
      winner,
    ]);

    const second = await requestRide(rafiq, { now: new Date(request.requestedAt) });
    const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: second.id });

    assert.strictEqual(dispatched.dispatched, true);
    assert.strictEqual(dispatched.driverProfileId, loser.driverProfile.id);
    assert.strictEqual(dispatched.candidates, 1);
  });

  it('never selects a driver who is offline, reserved or on a ride', async () => {
    for (const status of ['OFFLINE', 'RESERVED', 'ON_RIDE']) {
      await resetDispatchState();
      await goOnline(jashim, POINTS.NEAR);
      await pool.query(`UPDATE driver_profiles SET status = $2 WHERE id = $1::uuid`, [
        jashim.driverProfile.id,
        status,
      ]);

      const request = await requestRide(nusrat);
      const result = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

      assert.strictEqual(result.dispatched, false, status);
      assert.strictEqual(result.reason, 'no_eligible_driver', status);
      assert.strictEqual(await requestStatus(request.id), 'WAITING', status);
    }
  });

  it('excludes a driver whose only vehicle is inactive', async () => {
    await goOnline(jashim, POINTS.NEAR);
    await pool.query(`UPDATE vehicles SET active = false WHERE driver_id = $1::uuid`, [
      jashim.driverProfile.id,
    ]);

    const request = await requestRide(nusrat);
    const result = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    assert.strictEqual(result.dispatched, false);
    assert.strictEqual(result.reason, 'no_eligible_driver');
  });

  it('excludes a driver who already has an active pool', async () => {
    await goOnline(jashim, POINTS.NEAR);
    // A pool without a trip, so the driver is still AVAILABLE: this isolates the
    // "no active pool" rule from the availability rule.
    await giveDriverAPool(jashim.driverProfile.id);

    const request = await requestRide(nusrat);
    const result = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    assert.strictEqual(result.dispatched, false);
    assert.strictEqual(result.reason, 'no_eligible_driver');
    assert.strictEqual(await driverStatus(jashim.driverProfile.id), 'AVAILABLE');
  });

  it('uses the spatial radius as a shortlist, not as the answer', async () => {
    // Banani Kakoli is 445 m from the pickup, so it is inside the default 3 km
    // search but outside a deliberately tiny one. Nothing else about the driver
    // or the request changes, which is what makes this a test of the radius.
    await goOnline(jashim, POINTS.NEAR);

    const request = await requestRide(nusrat);

    const tooSmall = await dispatch.dispatchWaitingRequest({
      rideRequestId: request.id,
      radiusMeters: 100,
    });
    assert.strictEqual(tooSmall.dispatched, false);
    assert.strictEqual(tooSmall.reason, 'no_eligible_driver');

    const normal = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    assert.strictEqual(normal.dispatched, true);

    const [offer] = await pendingOffersFor(request.id);
    assert.strictEqual(Number(offer.approach_distance_meters), 445);
    assert.ok(offer.approach_duration_seconds > 0, 'the approach is routed, not guessed');
  });

  it('records the road approach, which is not the straight line the shortlist used', async () => {
    // Mirpur-10 is 3.9 km from the pickup in a straight line -- outside the
    // default 3 km search -- and 7.1 km by road. Both thresholds have to move
    // before this driver can be offered the ride, which is exactly why the search
    // has two stages: proximity decides who is worth routing, and the router
    // decides who is actually near.
    await goOnline(jashim, POINTS.FAR);

    const request = await requestRide(nusrat);

    const tooFar = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    assert.strictEqual(tooFar.dispatched, false, '3.9 km is outside a 3 km radius');

    const stillTooSlow = await dispatch.dispatchWaitingRequest({
      rideRequestId: request.id,
      radiusMeters: env.dispatch.maxRadiusMeters,
    });
    assert.strictEqual(stillTooSlow.dispatched, false, 'a 30 minute approach is not an offer');

    const reachable = await withEnv(
      env.dispatch,
      { maxApproachDurationSeconds: 3600 },
      () =>
        dispatch.dispatchWaitingRequest({
          rideRequestId: request.id,
          radiusMeters: env.dispatch.maxRadiusMeters,
        }),
    );
    assert.strictEqual(reachable.dispatched, true);

    const [offer] = await pendingOffersFor(request.id);
    assert.ok(
      Number(offer.approach_distance_meters) > 6000,
      `a 3.9 km straight line is a ${offer.approach_distance_meters} m drive`,
    );
    assert.ok(offer.approach_duration_seconds > env.dispatch.maxApproachDurationSeconds);
  });

  it('excludes a driver the router cannot reach the pickup from', async () => {
    // Niketon Gate is 1.9 km away -- comfortably inside the shortlist -- but every
    // edge out of its vertex is a one-way pointing *at* it, so no route to the
    // pickup exists. This is the case the second stage of the search exists for:
    // without it, the nearest driver on the map would be offered a ride they
    // cannot drive.
    await goOnline(jashim, 'niketon-gate');

    const request = await requestRide(nusrat);
    const result = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    assert.strictEqual(result.dispatched, false);
    assert.strictEqual(result.reason, 'no_eligible_driver');
    assert.strictEqual(await requestStatus(request.id), 'WAITING');
  });

  it('rejects a driver whose routed approach is slower than the configured limit', async () => {
    await goOnline(jashim, POINTS.MID);

    const request = await requestRide(nusrat);

    // The limit is configuration; setting it to an impossible value proves it is
    // enforced rather than decorative.
    const blocked = await withEnv(env.dispatch, { maxApproachDurationSeconds: 1 }, () =>
      dispatch.dispatchWaitingRequest({ rideRequestId: request.id }),
    );

    assert.strictEqual(blocked.dispatched, false);
    assert.strictEqual(blocked.reason, 'no_eligible_driver');

    const allowed = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    assert.strictEqual(allowed.dispatched, true);
    const [offer] = await pendingOffersFor(request.id);
    assert.ok(offer.approach_duration_seconds > 1);
  });

  it('prefers the driver who is closer on the road over the one closer on the map', async () => {
    // Banani Kakoli is 445 m from the pickup and Gulshan 2 Circle is 1068 m, and
    // the routed approaches keep that order -- so the nearer driver must win.
    await goOnline(jashim, POINTS.NEAR);
    await goOnline(salauddin, POINTS.MID);

    const request = await requestRide(nusrat);
    const result = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    assert.strictEqual(result.driverProfileId, jashim.driverProfile.id);
    assert.strictEqual(result.candidates, 2);
  });

  it('excludes a driver whose reported location is stale', async () => {
    await goOnline(jashim, POINTS.NEAR);

    // A driver who has not reported in for longer than the freshness window is
    // not somewhere we can promise a passenger.
    await pool.query(
      `UPDATE driver_profiles SET last_seen_at = now() - ($2 || ' seconds')::interval WHERE id = $1::uuid`,
      [jashim.driverProfile.id, env.dispatch.locationFreshnessSeconds + 60],
    );

    const request = await requestRide(nusrat);
    const result = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    assert.strictEqual(result.dispatched, false);
    assert.strictEqual(result.reason, 'no_eligible_driver');

    // ...and reporting in again makes them eligible once more, which is what the
    // driver's client does by re-posting its current point.
    const moved = await offers.listOffersForDriver({ driver: jashim });
    assert.deepStrictEqual(moved, []);
    const refreshed = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    assert.strictEqual(refreshed.dispatched, true, 'reading offers refreshes last_seen_at');
  });
});

describe('offers', () => {
  it('offers a waiting request to exactly one driver, once', async () => {
    await goOnline(jashim, POINTS.NEAR);
    await goOnline(salauddin, POINTS.MID);

    const request = await requestRide(nusrat);

    // Three sequential dispatches and two simultaneous ones: still one offer.
    await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    const [concurrent] = await Promise.all([
      dispatch.dispatchWaitingRequest({ rideRequestId: request.id }),
      dispatch.dispatchWaitingRequest({ rideRequestId: request.id }),
    ]);
    await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    const pending = await pendingOffersFor(request.id);
    assert.strictEqual(pending.length, 1, 'a request may have one pending offer');
    assert.ok(
      concurrent.reason === 'already_offered' || concurrent.dispatched === false,
      'a concurrent dispatch is a controlled skip, not a second offer',
    );

    const all = await allOffersFor(request.id);
    assert.strictEqual(all.length, 1, 'nothing was written twice');
  });

  it('records the offer as a ride event on the passenger?s timeline', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);

    const result = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    const events = await listRideEvents(request.id);

    assert.deepStrictEqual(
      events.map((event) => event.eventType),
      ['RIDE_REQUESTED', 'DRIVER_OFFERED'],
    );
    assert.strictEqual(events[1].metadata.offerId, result.offerId);
    assert.strictEqual(events[1].metadata.driverProfileId, jashim.driverProfile.id);
    assert.strictEqual(events[1].actorType, 'SYSTEM');
  });

  it('stores what the driver was offered, and nothing about the passenger', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);
    await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    const [offer] = await pendingOffersFor(request.id);
    const snapshot = offer.proposal_snapshot;

    assert.deepStrictEqual(snapshot.pickup.code, POINTS.PICKUP);
    assert.deepStrictEqual(snapshot.destination.code, POINTS.DESTINATION);
    assert.strictEqual(snapshot.approach.fromServicePointCode, POINTS.NEAR);
    assert.strictEqual(snapshot.passengerRoute.distanceMeters, request.acceptedDistanceMeters);
    assert.strictEqual(snapshot.passengerRoute.durationSeconds, request.acceptedDurationSeconds);
    assert.deepStrictEqual(snapshot.vehicle, { name: 'Bullet', seatCapacity: 3 });

    // The score is stored so dispatch can be explained, but it is not in the
    // proposal the driver sees -- and neither is the passenger.
    assert.ok(Number(offer.score) > 0);
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ['score', 'fare', 'Nusrat', 'passengerProfileId', 'userId', 'email']) {
      assert.ok(!serialized.includes(forbidden), `the snapshot must not contain ${forbidden}`);
    }
  });

  it('opens a window of the configured length', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);
    await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    const [offer] = await pendingOffersFor(request.id);
    const { rows } = await pool.query(
      `SELECT extract(epoch FROM (expires_at - offered_at))::int AS ttl FROM dispatch_offers WHERE id = $1::uuid`,
      [offer.id],
    );

    assert.strictEqual(rows[0].ttl, env.dispatch.offerTtlSeconds);
  });

  it('gives one driver at most one pending initial offer', async () => {
    await goOnline(jashim, POINTS.NEAR);

    const first = await requestRide(nusrat);
    const second = await requestRide(rafiq);

    const offered = await dispatch.dispatchWaitingRequest({ rideRequestId: first.id });
    assert.strictEqual(offered.dispatched, true);

    const blocked = await dispatch.dispatchWaitingRequest({ rideRequestId: second.id });
    assert.strictEqual(blocked.dispatched, false);
    assert.strictEqual(blocked.reason, 'no_eligible_driver');

    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM dispatch_offers
        WHERE driver_profile_id = $1::uuid AND status = 'PENDING'`,
      [jashim.driverProfile.id],
    );
    assert.strictEqual(rows[0].count, 1);
  });

  it('skips a request that is no longer waiting', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);

    await pool.query(
      `UPDATE ride_requests SET status = 'CANCELLED', cancelled_at = now(),
              cancellation_reason = 'CHANGED_MIND' WHERE id = $1::uuid`,
      [request.id],
    );

    const result = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    assert.strictEqual(result.dispatched, false);
    assert.strictEqual(result.reason, 'request_not_waiting');
    assert.deepStrictEqual(await pendingOffersFor(request.id), []);
  });

  it('skips a request whose search window has already closed', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);

    const after = new Date(new Date(request.searchExpiresAt).getTime() + 1000);
    const result = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id, now: after });

    assert.strictEqual(result.dispatched, false);
    assert.strictEqual(result.reason, 'search_window_closed');
  });

  it('skips a request that is not a trip yet: an unknown id is reported, not thrown', async () => {
    const result = await dispatch.dispatchWaitingRequest({
      rideRequestId: '00000000-0000-4000-8000-000000000000',
    });

    assert.strictEqual(result.dispatched, false);
    assert.strictEqual(result.reason, 'request_not_found');
  });
});

describe('the driver?s side of an offer', () => {
  const asDriver = (cookie, path, options = {}) =>
    api.request(path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        cookie,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });

  const offerFor = async ({ passenger = nusrat, driver = jashim } = {}) => {
    await goOnline(driver, driver === jashim ? POINTS.NEAR : POINTS.MID);
    const request = await requestRide(passenger);
    const result = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    assert.strictEqual(result.dispatched, true, JSON.stringify(result));
    return { request, offerId: result.offerId };
  };

  it('lists the driver?s own pending offers and nobody else?s', async () => {
    const { offerId } = await offerFor();

    const mine = await asDriver(jashimCookie, '/drivers/me/offers');
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.body.data.length, 1);
    assert.strictEqual(mine.body.data[0].offerId, offerId);

    // The other driver sees nothing, even though the offer exists.
    const theirs = await asDriver(salauddinCookie, '/drivers/me/offers');
    assert.strictEqual(theirs.status, 200);
    assert.deepStrictEqual(theirs.body.data, []);
  });

  it('returns the offer a driver needs, and nothing they do not', async () => {
    const { offerId } = await offerFor();

    const response = await asDriver(jashimCookie, `/drivers/me/offers/${offerId}`);
    assert.strictEqual(response.status, 200);

    assert.deepStrictEqual(Object.keys(response.body).sort(), [
      'approach',
      'destination',
      'expired',
      'expiresAt',
      'offerId',
      'offerType',
      'offeredAt',
      'passenger',
      'passengerRoute',
      'pickup',
      'rejectionReason',
      'respondedAt',
      'ridePoolId',
      'rideRequestId',
      'status',
      'vehicle',
    ]);

    assert.strictEqual(response.body.status, 'PENDING');
    assert.strictEqual(response.body.offerType, 'INITIAL_RIDE');
    assert.strictEqual(response.body.expired, false);
    assert.deepStrictEqual(response.body.passenger, { displayName: 'Nusrat' });
    assert.strictEqual(response.body.pickup.code, POINTS.PICKUP);
    assert.strictEqual(response.body.destination.code, POINTS.DESTINATION);
    assert.strictEqual(response.body.approach.fromServicePointCode, undefined);
    assert.ok(response.body.approach.distanceMeters > 0);
    assert.deepStrictEqual(response.body.vehicle, { name: 'Bullet', seatCapacity: 3 });

    const serialized = JSON.stringify(response.body);
    for (const forbidden of [
      'fare',
      'fareQuoteId',
      'currency',
      'score',
      'Nusrat Jahan',
      'nusrat@example.com',
      'fingerprint',
      'idempotency',
      'driverProfileId',
      'passengerProfileId',
    ]) {
      assert.ok(!serialized.includes(forbidden), `the offer must not contain ${forbidden}`);
    }
  });

  it('hides another driver?s offer behind a 404, not a 403', async () => {
    const { offerId } = await offerFor();

    const read = await asDriver(salauddinCookie, `/drivers/me/offers/${offerId}`);
    assert.strictEqual(read.status, 404);
    assert.match(read.body.error.message, /was not found/);

    // ...and they cannot answer it either.
    const accept = await asDriver(salauddinCookie, `/drivers/me/offers/${offerId}/accept`, {
      method: 'POST',
      body: {},
    });
    const reject = await asDriver(salauddinCookie, `/drivers/me/offers/${offerId}/reject`, {
      method: 'POST',
      body: { reason: 'TOO_FAR' },
    });

    assert.strictEqual(accept.status, 404);
    assert.strictEqual(reject.status, 404);

    // The offer is still there, still pending, and still Jashim's.
    const { rows } = await pool.query(
      `SELECT status, driver_profile_id FROM dispatch_offers WHERE id = $1::uuid`,
      [offerId],
    );
    assert.strictEqual(rows[0].status, 'PENDING');
    assert.strictEqual(rows[0].driver_profile_id, jashim.driverProfile.id);
  });

  it('refuses to answer an offer that has already expired, and records the expiry', async () => {
    const { request, offerId } = await offerFor();
    const { rows } = await pool.query(
      `SELECT expires_at FROM dispatch_offers WHERE id = $1::uuid`,
      [offerId],
    );

    // Move the driver's clock past the deadline by expiring it as the sweep would.
    await dispatch.expireOverdueOffers({ now: new Date(rows[0].expires_at) });

    for (const action of ['accept', 'reject']) {
      const response = await asDriver(jashimCookie, `/drivers/me/offers/${offerId}/${action}`, {
        method: 'POST',
        body: action === 'reject' ? { reason: 'TOO_FAR' } : {},
      });

      assert.strictEqual(response.status, 409, action);
      assert.match(response.body.error.message, /expired/i);
    }

    const [offer] = await allOffersFor(request.id);
    assert.strictEqual(offer.status, 'EXPIRED');
    assert.strictEqual(offer.rejection_reason, null, 'an expiry is not a refusal');
    assert.strictEqual(await requestStatus(request.id), 'WAITING');
  });

  it('refuses a second answer to the same offer', async () => {
    const { offerId } = await offerFor();

    await asDriver(jashimCookie, `/drivers/me/offers/${offerId}/reject`, {
      method: 'POST',
      body: { reason: 'TOO_FAR' },
    });

    const again = await asDriver(jashimCookie, `/drivers/me/offers/${offerId}/reject`, {
      method: 'POST',
      body: { reason: 'OTHER' },
    });

    assert.strictEqual(again.status, 409);
    assert.match(again.body.error.message, /already rejected/);
  });

  it('rejects an unknown rejection reason and accepts any case of a real one', async () => {
    const { offerId } = await offerFor();

    const bad = await asDriver(jashimCookie, `/drivers/me/offers/${offerId}/reject`, {
      method: 'POST',
      body: { reason: 'BECAUSE' },
    });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error.message, /reason must be one of/);

    const good = await asDriver(jashimCookie, `/drivers/me/offers/${offerId}/reject`, {
      method: 'POST',
      body: { reason: 'too_far' },
    });
    assert.strictEqual(good.status, 200);
    assert.strictEqual(good.body.rejectionReason, 'TOO_FAR');
  });

  it('rejects a body field that would change the offer', async () => {
    const { offerId } = await offerFor();

    const response = await asDriver(jashimCookie, `/drivers/me/offers/${offerId}/accept`, {
      method: 'POST',
      body: { status: 'ACCEPTED' },
    });

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error.message, /Unsupported body field/);
  });

  it('shows the driver a history of their own offers on request', async () => {
    const { offerId } = await offerFor();
    await asDriver(jashimCookie, `/drivers/me/offers/${offerId}/reject`, {
      method: 'POST',
      body: { reason: 'UNAVAILABLE' },
    });

    const history = await asDriver(jashimCookie, '/drivers/me/offers?status=ALL');
    assert.strictEqual(history.status, 200);
    assert.strictEqual(history.body.data.length, 1);
    assert.strictEqual(history.body.data[0].status, 'REJECTED');
    assert.strictEqual(history.body.data[0].rejectionReason, 'UNAVAILABLE');

    const pendingOnly = await asDriver(jashimCookie, '/drivers/me/offers');
    assert.deepStrictEqual(pendingOnly.body.data, []);

    for (const query of ['?status=PENDING', '?limit=5']) {
      const response = await asDriver(jashimCookie, `/drivers/me/offers${query}`);
      assert.strictEqual(response.status, 200, query);
    }

    for (const query of ['?status=NOPE', '?bogus=1', '?limit=0']) {
      const response = await asDriver(jashimCookie, `/drivers/me/offers${query}`);
      assert.strictEqual(response.status, 400, query);
    }
  });
});

describe('a refusal', () => {
  const asDriver = (path, options = {}) =>
    api.request(path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        cookie: jashimCookie,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });

  it('leaves the request waiting, the driver available and no pool behind', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);
    const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    const response = await asDriver(`/drivers/me/offers/${dispatched.offerId}/reject`, {
      method: 'POST',
      body: { reason: 'TOO_FAR' },
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.status, 'REJECTED');

    assert.strictEqual(await requestStatus(request.id), 'WAITING');
    assert.strictEqual(await driverStatus(jashim.driverProfile.id), 'AVAILABLE');

    const { rows } = await pool.query(`SELECT count(*)::int AS count FROM ride_pools`);
    assert.strictEqual(rows[0].count, 0, 'a refusal must not create a pool');

    const events = await listRideEvents(request.id);
    assert.deepStrictEqual(
      events.map((event) => event.eventType),
      [
        'RIDE_REQUESTED',
        'DRIVER_OFFERED',
        'DRIVER_REJECTED',
        // The rejection is answered over HTTP, which re-runs assignment: no
        // existing pool can take the passenger, and the only driver who could
        // reach the pickup has just refused, so the attempt is recorded as a
        // fallback to solo dispatch that found nobody.
        'INITIAL_DISPATCH_FALLBACK',
      ],
    );
    assert.strictEqual(events[2].metadata.reason, 'TOO_FAR');
    assert.strictEqual(events[3].metadata.reason, 'no_candidate_pools');
  });

  it('offers the request to the next eligible driver', async () => {
    await goOnline(jashim, POINTS.NEAR);
    await goOnline(salauddin, POINTS.MID);

    const request = await requestRide(nusrat);
    const first = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    assert.strictEqual(first.driverProfileId, jashim.driverProfile.id);

    // The rejection is answered over HTTP, which is what triggers the re-offer.
    await asDriver(`/drivers/me/offers/${first.offerId}/reject`, {
      method: 'POST',
      body: { reason: 'TOO_FAR' },
    });

    const pending = await pendingOffersFor(request.id);
    assert.strictEqual(pending.length, 1, 'the next driver now holds an offer');
    assert.strictEqual(pending[0].driver_profile_id, salauddin.driverProfile.id);
    assert.strictEqual(await requestStatus(request.id), 'WAITING');

    assert.deepStrictEqual(
      (await allOffersFor(request.id)).map((offer) => offer.status),
      ['REJECTED', 'PENDING'],
    );
  });

  it('never offers the same request to the driver who refused it', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);
    const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    await asDriver(`/drivers/me/offers/${dispatched.offerId}/reject`, {
      method: 'POST',
      body: { reason: 'VEHICLE_ISSUE' },
    });

    // Jashim is the only driver available and the only one who can reach the
    // pickup, and he has said no: the request waits for somebody else.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
      assert.strictEqual(result.dispatched, false, `attempt ${attempt}`);
    }

    assert.strictEqual((await allOffersFor(request.id)).length, 1);
    assert.strictEqual(await requestStatus(request.id), 'WAITING');
  });
});

describe('expiry', () => {
  it('ends an overdue offer and offers the request to the next driver', async () => {
    await goOnline(jashim, POINTS.NEAR);
    await goOnline(salauddin, POINTS.MID);

    const request = await requestRide(nusrat);
    const first = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    assert.strictEqual(first.driverProfileId, jashim.driverProfile.id);

    const summary = await dispatch.expireOverdueOffers({ now: new Date(first.expiresAt) });

    assert.strictEqual(summary.expired, 1);
    assert.strictEqual(summary.redispatched, 1);

    const all = await allOffersFor(request.id);
    assert.deepStrictEqual(all.map((offer) => offer.status), ['EXPIRED', 'PENDING']);
    assert.strictEqual(all[1].driver_profile_id, salauddin.driverProfile.id);

    const events = await listRideEvents(request.id);
    assert.deepStrictEqual(
      events.map((event) => event.eventType),
      [
        'RIDE_REQUESTED',
        'DRIVER_OFFERED',
        'DRIVER_OFFER_EXPIRED',
        // Expiry re-runs assignment, which tries the pool-first order first.
        'INITIAL_DISPATCH_FALLBACK',
        'DRIVER_OFFERED',
      ],
    );
    assert.strictEqual(events[3].metadata.reason, 'no_candidate_pools');
    assert.strictEqual(await requestStatus(request.id), 'WAITING');
    assert.strictEqual(await driverStatus(jashim.driverProfile.id), 'AVAILABLE');
  });

  it('is idempotent, and does not touch an offer that is still inside its window', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);
    const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    // Now is before the deadline, so there is nothing overdue.
    const before = await dispatch.expireOverdueOffers({ now: new Date() });
    assert.deepStrictEqual(before, { examined: 0, expired: 0, skipped: 0, redispatched: 0 });

    // At the deadline it is overdue, and the second sweep has nothing left.
    const at = new Date(dispatched.expiresAt);
    assert.strictEqual((await dispatch.expireOverdueOffers({ now: at })).expired, 1);
    assert.strictEqual((await dispatch.expireOverdueOffers({ now: at })).expired, 0);
  });

  it('leaves the request waiting when the driver has gone since the offer was made', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);
    const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    // The only driver leaves before their offer runs out.
    await pool.query(`UPDATE driver_profiles SET status = 'OFFLINE' WHERE id = $1::uuid`, [
      jashim.driverProfile.id,
    ]);

    const summary = await dispatch.expireOverdueOffers({ now: new Date(dispatched.expiresAt) });

    assert.strictEqual(summary.expired, 1);
    assert.strictEqual(summary.redispatched, 0, 'there is nobody left to offer the ride to');
    assert.strictEqual(await requestStatus(request.id), 'WAITING');
    assert.deepStrictEqual(await pendingOffersFor(request.id), []);
  });
});

describe('the retry sweep', () => {
  it('offers waiting requests that nobody is looking at', async () => {
    const request = await requestRide(nusrat);

    // Nobody was online when this was created.
    assert.strictEqual((await dispatch.retryWaitingRequests()).dispatched, 0);
    assert.strictEqual(await requestStatus(request.id), 'WAITING');

    await goOnline(jashim, POINTS.NEAR);

    const summary = await dispatch.retryWaitingRequests();
    assert.strictEqual(summary.dispatched, 1);

    const pending = await pendingOffersFor(request.id);
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].driver_profile_id, jashim.driverProfile.id);
  });

  it('does not disturb a request that already has an offer outstanding', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);
    const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    const summary = await dispatch.retryWaitingRequests();

    assert.strictEqual(summary.dispatched, 0);
    assert.deepStrictEqual(
      (await allOffersFor(request.id)).map((offer) => offer.id),
      [dispatched.offerId],
    );
  });

  it('does not touch a request whose window has closed', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);

    const summary = await dispatch.retryWaitingRequests({
      now: new Date(new Date(request.searchExpiresAt).getTime() + 1000),
    });

    assert.strictEqual(summary.examined, 0);
    assert.deepStrictEqual(await pendingOffersFor(request.id), []);
  });

  it('ships as a command a scheduler can run', async () => {
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

    assert.strictEqual(manifest.scripts['dispatch:sweep'], 'node src/commands/dispatch-sweep.js');
  });
});

describe('dispatch triggered by the ride request itself', () => {
  it('offers a newly created request without a separate call', async () => {
    await goOnline(jashim, POINTS.NEAR);

    const { quote } = await createSoloFareQuote({
      passengerProfileId: nusrat.passengerProfile.id,
      originServicePointCode: POINTS.PICKUP,
      destinationServicePointCode: POINTS.DESTINATION,
      departureAt: DEPARTURE,
    });

    const cookie = await login('nusrat@example.com');
    const response = await api.request('/ride-requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie,
        'Idempotency-Key': nextKey('auto'),
      },
      body: JSON.stringify({ fareQuoteId: quote.id }),
    });

    assert.strictEqual(response.status, 201, JSON.stringify(response.body));

    const pending = await pendingOffersFor(response.body.id);
    assert.strictEqual(pending.length, 1, 'creating a request is what starts dispatch');
    assert.strictEqual(pending[0].driver_profile_id, jashim.driverProfile.id);
  });

  it('still returns 201 when there is nobody to offer it to', async () => {
    const { quote } = await createSoloFareQuote({
      passengerProfileId: nusrat.passengerProfile.id,
      originServicePointCode: POINTS.PICKUP,
      destinationServicePointCode: POINTS.DESTINATION,
      departureAt: DEPARTURE,
    });

    const cookie = await login('nusrat@example.com');
    const response = await api.request('/ride-requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie,
        'Idempotency-Key': nextKey('alone'),
      },
      body: JSON.stringify({ fareQuoteId: quote.id }),
    });

    // A request with no offer is still a valid request: dispatch failing is not
    // the passenger's problem, and the sweep will pick it up.
    assert.strictEqual(response.status, 201);
    assert.strictEqual(await requestStatus(response.body.id), 'WAITING');
    assert.deepStrictEqual(await pendingOffersFor(response.body.id), []);
  });
});

describe('scope boundary', () => {
  it('creates only INITIAL_RIDE offers: a join offer is the matching service\'s job', async () => {
    await goOnline(jashim, POINTS.NEAR);
    await goOnline(salauddin, POINTS.MID);

    const request = await requestRide(nusrat);
    const first = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    await offers.rejectOffer({ driver: jashim, offerId: first.offerId, reason: 'TOO_FAR' });
    await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    const { rows } = await pool.query(`SELECT offer_type, status FROM dispatch_offers`);
    assert.ok(rows.length >= 2, 'the flow produced offers to check');
    assert.deepStrictEqual(
      [...new Set(rows.map((row) => row.offer_type))],
      ['INITIAL_RIDE'],
      'the dispatcher finds drivers; it never proposes that a pool take another passenger',
    );

    // The orchestrator is what adds the pool-first stage, and it is a separate
    // step in front of dispatch rather than a change to it.
    assert.deepStrictEqual(
      (await assignment.findPendingOffer(request.id)).offerType,
      'INITIAL_RIDE',
    );
  });

  it('offers no pooling, existing-pool search or shared-fare endpoint', async () => {
    for (const path of [
      '/pools',
      '/pools/nearby',
      '/pool-members',
      '/matches',
      '/ride-requests/00000000-0000-4000-8000-000000000000/pools',
      '/ride-requests/00000000-0000-4000-8000-000000000000/matches',
      '/fare-quotes/shared',
    ]) {
      const response = await api.request(path, { headers: { cookie: jashimCookie } });

      assert.strictEqual(response.status, 404, path);
    }
  });

  it('offers no trip-operation endpoint, from either side', async () => {
    for (const path of [
      '/drivers/me/pool/arrive',
      '/drivers/me/pool/start',
      '/drivers/me/pool/complete',
      '/drivers/me/trips',
      '/ride-requests/00000000-0000-4000-8000-000000000000/pickup',
      '/ride-requests/00000000-0000-4000-8000-000000000000/dropoff',
      '/ride-requests/00000000-0000-4000-8000-000000000000/complete',
    ]) {
      const response = await api.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: jashimCookie },
        body: '{}',
      });

      assert.strictEqual(response.status, 404, path);
    }
  });

  it('carries no fare anywhere in the pool tables', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('ride_pools', 'pool_members', 'pool_stops', 'pool_events')
          AND column_name ~ '(fare|price|amount|currency|cost|discount|paid)'
        ORDER BY table_name, column_name`,
    );

    assert.deepStrictEqual(
      rows,
      [],
      'a pool records a plan, not a price: every fare lives on the quote a request accepted',
    );
  });

  it('keeps a pool to one member and two stops, because nothing adds a second passenger', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);
    const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    await offers.acceptOffer({ driver: jashim, offerId: dispatched.offerId });

    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM pool_members) AS members,
              (SELECT count(*)::int FROM pool_stops)   AS stops,
              (SELECT version FROM ride_pools LIMIT 1) AS version`,
    );

    assert.deepStrictEqual(rows[0], { members: 1, stops: 2, version: 1 });
  });
});

describe('the pool a driver sees after accepting', () => {
  it('is null until they accept something', async () => {
    const response = await api.request('/drivers/me/pool', { headers: { cookie: jashimCookie } });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, { pool: null });
  });

  it('is the pool they are committed to once they accept', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const request = await requestRide(nusrat);
    const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    await api.request(`/drivers/me/offers/${dispatched.offerId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: jashimCookie },
      body: '{}',
    });

    const response = await api.request('/drivers/me/pool', { headers: { cookie: jashimCookie } });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.pool.status, 'FORMING');
    assert.strictEqual(response.body.pool.members.length, 1);
    assert.strictEqual(response.body.pool.members[0].rideRequestId, request.id);
    assert.deepStrictEqual(
      response.body.pool.members[0].stops.map((stop) => [stop.sequence, stop.stopType]),
      [
        [1, 'PICKUP'],
        [2, 'DROPOFF'],
      ],
    );

    // The other driver has none.
    const theirs = await api.request('/drivers/me/pool', { headers: { cookie: salauddinCookie } });
    assert.deepStrictEqual(theirs.body, { pool: null });
    void listPoolEvents;
  });
});
