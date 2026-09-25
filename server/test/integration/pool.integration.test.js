import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import { createSoloFareQuote } from '../../src/services/fare.service.js';
import * as dispatch from '../../src/services/dispatch.service.js';
import * as offers from '../../src/services/offer.service.js';
import { listPoolEvents } from '../../src/services/pool.service.js';
import {
  cancelRideRequest,
  createRideRequest,
  listRideEvents,
} from '../../src/services/ride-request.service.js';
import { startApiServer } from '../helpers/api-server.js';
import { closePool, expectPgError, pool, prepareDatabase, withRollback } from '../helpers/db.js';
import {
  createTestDriver,
  goOnline,
  loadDemoUser,
  POINTS,
  removeTestDriver,
  resetDispatchState,
  servicePointId,
} from '../helpers/drivers.js';

/**
 * Acceptance: the one transaction that turns a waiting request into a pool.
 *
 * Three kinds of test live here, and they answer different questions:
 *
 *   1. what acceptance *produces* -- the pool, its member, its two stops, the
 *      status changes and the audit events;
 *   2. what it refuses, and that a refusal leaves nothing behind;
 *   3. what two concurrent writers cannot both do.
 *
 * The third is the reason most of the rules in 09-driver-dispatch.sql exist, so
 * it is tested against the real database rather than mocked: a race that only a
 * constraint can settle is not settled by a service check.
 */

const DEPARTURE = new Date('2026-09-24T08:41:00+06:00');

let api;
let nusrat;
let rafiq;
let shirin;
let jashim;
let salauddin;
let points;
/** A committed WAITING request per passenger, reused by the SQL-level tests. */
let fixtures;

let sequence = 0;
const nextKey = (label = 'pool') => `${label}-key-${Date.now()}-${(sequence += 1)}`;

const asDriver = (cookie, path, options = {}) =>
  api.request(path, {
    method: options.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

/** A fresh quote and a fresh WAITING request, without triggering dispatch. */
const requestRide = async (passenger) => {
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
  });

  return request;
};

/** Offers `passenger`'s new request to `driver` and returns both. */
const offerTo = async (driver, passenger) => {
  await goOnline(driver, driver === jashim ? POINTS.NEAR : POINTS.MID);
  const request = await requestRide(passenger);
  const result = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
  assert.strictEqual(result.dispatched, true, JSON.stringify(result));
  return { request, offerId: result.offerId };
};

const acceptAs = (driver) => (offerId) =>
  offers.acceptOffer({
    driver,
    offerId,
  });

const stateOf = async (rideRequestId) => {
  const [request] = (
    await pool.query(`SELECT status FROM ride_requests WHERE id = $1::uuid`, [rideRequestId])
  ).rows;
  const [offer] = (
    await pool.query(
      `SELECT status, responded_at, ride_pool_id FROM dispatch_offers WHERE ride_request_id = $1::uuid`,
      [rideRequestId],
    )
  ).rows;
  const member = (
    await pool.query(`SELECT id, ride_pool_id, status FROM pool_members WHERE ride_request_id = $1::uuid`, [
      rideRequestId,
    ])
  ).rows[0];
  const stops = (
    await pool.query(
      `SELECT sequence, stop_type, status, service_point_id, planned_arrival_at
         FROM pool_stops WHERE ride_request_id = $1::uuid ORDER BY sequence`,
      [rideRequestId],
    )
  ).rows;

  return { request, offer, member, stops };
};

const counts = async () => {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM ride_pools)   AS pools,
            (SELECT count(*)::int FROM pool_members) AS members,
            (SELECT count(*)::int FROM pool_stops)   AS stops,
            (SELECT count(*)::int FROM pool_events)  AS events`,
  );
  return rows[0];
};

/** Inserts a pool directly, so the constraint tests can reach past the service. */
const insertPool = async (tx, overrides = {}) => {
  const row = {
    driverProfileId: jashim.driverProfile.id,
    vehicleId: jashim.driverProfile.vehicles[0].id,
    status: 'FORMING',
    capacitySnapshot: 3,
    plannedDistanceMeters: 2214,
    plannedDurationSeconds: 569,
    version: 1,
    completedAt: null,
    cancelledAt: null,
    startedAt: null,
    ...overrides,
  };

  const { rows } = await tx.query(
    `INSERT INTO ride_pools (driver_profile_id, vehicle_id, status, capacity_snapshot,
                             planned_distance_meters, planned_duration_seconds, version,
                             completed_at, cancelled_at, started_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      row.driverProfileId,
      row.vehicleId,
      row.status,
      row.capacitySnapshot,
      row.plannedDistanceMeters,
      row.plannedDurationSeconds,
      row.version,
      row.completedAt,
      row.cancelledAt,
      row.startedAt,
    ],
  );

  return rows[0].id;
};

const insertMember = async (tx, { ridePoolId, rideRequestId, status = 'ASSIGNED' }) => {
  const { rows } = await tx.query(
    `INSERT INTO pool_members (ride_pool_id, ride_request_id, status)
     VALUES ($1::uuid, $2::uuid, $3) RETURNING id`,
    [ridePoolId, rideRequestId, status],
  );
  return rows[0].id;
};

const insertStop = async (tx, { ridePoolId, rideRequestId, poolMemberId, servicePointId, stopType, sequence }) => {
  const { rows } = await tx.query(
    `INSERT INTO pool_stops (ride_pool_id, ride_request_id, pool_member_id, service_point_id,
                             stop_type, sequence, planned_arrival_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, now()) RETURNING id`,
    [ridePoolId, rideRequestId, poolMemberId, servicePointId, stopType, sequence],
  );
  return rows[0].id;
};

before(async () => {
  await prepareDatabase();
  api = await startApiServer();

  nusrat = await loadDemoUser('nusrat@example.com');
  rafiq = await loadDemoUser('rafiq@example.com');
  shirin = await loadDemoUser('shirin@example.com');
  jashim = await loadDemoUser('jashim@example.com');
  salauddin = await createTestDriver({
    name: 'Salauddin',
    vehicleName: 'Second Car',
    password: env.demoSeedPassword,
  });

  points = {
    pickup: await servicePointId(POINTS.PICKUP),
    destination: await servicePointId(POINTS.DESTINATION),
    near: await servicePointId(POINTS.NEAR),
    mid: await servicePointId(POINTS.MID),
  };

  // This suite owns *every* vehicle except the seeded ones. A driver with two
  // active vehicles cannot go online without choosing, so a leftover from an
  // interrupted run would break the whole file in a way that looks like a bug in
  // the code under test. The demo cast keeps Bullet and Second Car is created by
  // the suite itself, so anything else is debris.
  await pool.query(`DELETE FROM vehicles WHERE name NOT IN ('Bullet', 'Second Car', 'Test Car')`);
});

beforeEach(async () => {
  await resetDispatchState();
  jashim = await loadDemoUser('jashim@example.com');
  salauddin = await loadDemoUser(salauddin.email);

  // Committed WAITING requests for the tests that write SQL directly. They are
  // deliberately created for passengers the acceptance tests do not use, because
  // a passenger may have only one active request at a time -- a fixture holding
  // Nusrat's slot would break every test that asks for a ride as her.
  fixtures = {
    shirin: await requestRide(shirin),
    rafiq: await requestRide(rafiq),
  };
});

after(async () => {
  await resetDispatchState();
  await removeTestDriver(salauddin.email);
  await api?.close();
  await closePool();
});

describe('accepting an offer', () => {
  it('creates exactly one FORMING pool with the vehicle?s capacity', async () => {
    const { request, offerId } = await offerTo(jashim, nusrat);

    const { pool: created } = await acceptAs(jashim)(offerId);

    assert.strictEqual(created.status, 'FORMING');
    assert.strictEqual(created.capacitySnapshot, 3);
    assert.strictEqual(created.version, 1);
    assert.strictEqual(Number(created.plannedDistanceMeters), request.acceptedDistanceMeters);
    assert.strictEqual(created.plannedDurationSeconds, request.acceptedDurationSeconds);
    assert.ok(created.acceptedAt);

    const all = await counts();
    assert.strictEqual(all.pools, 1);
    assert.strictEqual(all.members, 1);
    assert.strictEqual(all.stops, 2);

    // The route plan comes from the quote the passenger accepted, and it is
    // written through parameterised SQL because Prisma has no PostGIS types.
    const { rows } = await pool.query(
      `SELECT ST_NPoints(planned_route_geometry::geometry) AS points,
              ST_SRID(planned_route_geometry::geometry) AS srid
         FROM ride_pools WHERE id = $1::uuid`,
      [created.id],
    );
    assert.ok(rows[0].points >= 2, 'the passenger route geometry is stored with the pool');
    assert.strictEqual(rows[0].srid, 4326);
  });

  it('adds one member for the passenger?s own request', async () => {
    const { request, offerId } = await offerTo(jashim, nusrat);
    await acceptAs(jashim)(offerId);

    const state = await stateOf(request.id);

    assert.ok(state.member, 'the request has a pool member');
    assert.strictEqual(state.member.status, 'ASSIGNED');
    assert.strictEqual(
      state.member.ride_pool_id,
      (await pool.query(`SELECT id FROM ride_pools`)).rows[0].id,
    );

    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM pool_members WHERE ride_request_id = $1::uuid`,
      [request.id],
    );
    assert.strictEqual(rows[0].count, 1);
  });

  it('orders the plan: pickup first, drop-off second, at the request?s own places', async () => {
    const { request, offerId } = await offerTo(jashim, nusrat);
    const { pool: created } = await acceptAs(jashim)(offerId);

    const { stops } = await stateOf(request.id);

    assert.deepStrictEqual(
      stops.map((stop) => [stop.sequence, stop.stop_type]),
      [
        [1, 'PICKUP'],
        [2, 'DROPOFF'],
      ],
    );
    assert.strictEqual(stops[0].service_point_id, points.pickup);
    assert.strictEqual(stops[1].service_point_id, points.destination);

    // The pickup is planned for when the driver is expected to arrive -- after
    // the approach the offer was made with -- and the drop-off one passenger
    // journey later, which is the journey the quote priced.
    const secondsBetween = (from, to) => (new Date(to).getTime() - new Date(from).getTime()) / 1000;

    const toPickup = secondsBetween(created.acceptedAt, stops[0].planned_arrival_at);
    const journey = secondsBetween(stops[0].planned_arrival_at, stops[1].planned_arrival_at);

    assert.ok(toPickup > 0, `the pickup is planned after the approach (${toPickup}s)`);
    assert.strictEqual(journey, request.acceptedDurationSeconds);
  });

  it('moves the request to MATCHED, the driver to RESERVED and the offer to ACCEPTED', async () => {
    const { request, offerId } = await offerTo(jashim, nusrat);
    const { pool: created } = await acceptAs(jashim)(offerId);

    const state = await stateOf(request.id);
    assert.strictEqual(state.request.status, 'MATCHED');
    assert.strictEqual(state.offer.status, 'ACCEPTED');
    assert.ok(state.offer.responded_at);
    assert.strictEqual(state.offer.ride_pool_id, created.id);

    const { rows } = await pool.query(
      `SELECT status, available_since FROM driver_profiles WHERE id = $1::uuid`,
      [jashim.driverProfile.id],
    );
    assert.strictEqual(rows[0].status, 'RESERVED');
    assert.strictEqual(rows[0].available_since, null, 'a reserved driver is not idling');
  });

  it('appends both timelines: the request?s and the pool?s', async () => {
    const { request, offerId } = await offerTo(jashim, nusrat);
    const { pool: created } = await acceptAs(jashim)(offerId);

    const rideEvents = await listRideEvents(request.id);
    assert.deepStrictEqual(
      rideEvents.map((event) => event.eventType),
      ['RIDE_REQUESTED', 'DRIVER_OFFERED', 'PASSENGER_MATCHED', 'DRIVER_ACCEPTED'],
    );

    const matched = rideEvents[2];
    assert.strictEqual(matched.previousStatus, 'WAITING');
    assert.strictEqual(matched.newStatus, 'MATCHED');
    assert.strictEqual(matched.actorType, 'SYSTEM');

    const accepted = rideEvents[3];
    assert.strictEqual(accepted.metadata.ridePoolId, created.id);
    assert.strictEqual(accepted.metadata.driverProfileId, jashim.driverProfile.id);

    const poolEvents = await listPoolEvents(created.id);
    assert.deepStrictEqual(
      poolEvents.map((event) => [event.sequence, event.eventType, event.actorType]),
      [
        [1, 'POOL_CREATED', 'DRIVER'],
        [2, 'MEMBER_ADDED', 'DRIVER'],
        [3, 'ROUTE_PLAN_CREATED', 'SYSTEM'],
      ],
    );
    assert.strictEqual(poolEvents[0].actorUserId, jashim.id);
  });

  it('answers the accepted driver with their pool, over HTTP', async () => {
    await goOnline(jashim, POINTS.NEAR);
    const cookie = await loginAs('jashim@example.com');

    const { quote } = await createSoloFareQuote({
      passengerProfileId: nusrat.passengerProfile.id,
      originServicePointCode: POINTS.PICKUP,
      destinationServicePointCode: POINTS.DESTINATION,
      departureAt: DEPARTURE,
    });
    const { request } = await createRideRequest({
      passenger: nusrat,
      fareQuoteId: quote.id,
      idempotencyKey: nextKey(),
    });
    const dispatched = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    const response = await asDriver(cookie, `/drivers/me/offers/${dispatched.offerId}/accept`, {
      body: {},
    });

    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.strictEqual(response.body.status, 'FORMING');
    assert.strictEqual(response.body.capacity, 3);
    assert.strictEqual(response.body.members.length, 1);
    assert.strictEqual(response.body.members[0].rideRequestId, request.id);
    assert.deepStrictEqual(response.body.members[0].passenger, { displayName: 'Nusrat' });
    assert.deepStrictEqual(
      response.body.members[0].stops.map((stop) => [stop.sequence, stop.stopType]),
      [
        [1, 'PICKUP'],
        [2, 'DROPOFF'],
      ],
    );

    // The driver is told nothing about the money the passenger agreed to.
    const serialized = JSON.stringify(response.body);
    for (const forbidden of ['fare', 'fareQuoteId', 'currency', 'score', 'fingerprint']) {
      assert.ok(!serialized.includes(forbidden), `the pool must not contain ${forbidden}`);
    }
  });

  it('refuses an offer that is not the driver?s, without revealing it exists', async () => {
    const { offerId } = await offerTo(jashim, nusrat);

    await assert.rejects(
      () => acceptAs(salauddin)(offerId),
      (err) => {
        assert.strictEqual(err.statusCode, 404);
        return true;
      },
    );

    assert.deepStrictEqual(await counts(), {
      pools: 0,
      members: 0,
      stops: 0,
      events: 0,
    });
  });
});

describe('guards at acceptance time', () => {
  const rejectWith = async (action, expectedStatus, messagePattern) => {
    await assert.rejects(action, (err) => {
      assert.strictEqual(err.statusCode, expectedStatus, err.message);
      if (messagePattern) assert.match(err.message, messagePattern);
      return true;
    });
  };

  it('refuses when the request was cancelled after the offer was made', async () => {
    const { request, offerId } = await offerTo(jashim, nusrat);

    await cancelRideRequest({ passenger: nusrat, rideRequestId: request.id, reason: 'CHANGED_MIND' });

    await rejectWith(() => acceptAs(jashim)(offerId), 409, /no longer waiting|already cancelled/);
    assert.deepStrictEqual(await counts(), { pools: 0, members: 0, stops: 0, events: 0 });
  });

  it('refuses when the driver went offline between the offer and the answer', async () => {
    const { offerId } = await offerTo(jashim, nusrat);

    await pool.query(`UPDATE driver_profiles SET status = 'OFFLINE' WHERE id = $1::uuid`, [
      jashim.driverProfile.id,
    ]);

    await rejectWith(() => acceptAs(jashim)(offerId), 409, /cannot accept a ride/);
    assert.deepStrictEqual(await counts(), { pools: 0, members: 0, stops: 0, events: 0 });
  });

  it('refuses when the vehicle was deactivated between the offer and the answer', async () => {
    const { request, offerId } = await offerTo(jashim, nusrat);

    await pool.query(`UPDATE vehicles SET active = false WHERE driver_id = $1::uuid`, [
      jashim.driverProfile.id,
    ]);

    await rejectWith(() => acceptAs(jashim)(offerId), 409, /vehicle is no longer active/);

    // ...and nothing partial was written.
    assert.deepStrictEqual(await counts(), { pools: 0, members: 0, stops: 0, events: 0 });
    const state = await stateOf(request.id);
    assert.strictEqual(state.request.status, 'WAITING');
    assert.strictEqual(state.offer.status, 'PENDING');
    assert.strictEqual(await driverStatusOf(jashim.driverProfile.id), 'AVAILABLE');
  });

  it('refuses when the driver switched to another vehicle after the offer', async () => {
    const { offerId } = await offerTo(jashim, nusrat);

    await pool.query(
      `INSERT INTO vehicles (driver_id, name, seat_capacity, active)
       SELECT id, 'Spare Car', 2, true FROM driver_profiles WHERE id = $1::uuid`,
      [jashim.driverProfile.id],
    );

    try {
      await pool.query(
        `UPDATE driver_profiles SET active_vehicle_id = (
           SELECT id FROM vehicles WHERE name = 'Spare Car' AND driver_id = $1::uuid)
          WHERE id = $1::uuid`,
        [jashim.driverProfile.id],
      );

      await rejectWith(() => acceptAs(jashim)(offerId), 409, /active vehicle has changed/);
    } finally {
      // A second active vehicle would make every later test's "go online"
      // ambiguous, which is the behaviour under test -- so it must not outlive
      // this test.
      await pool.query(`DELETE FROM vehicles WHERE name = 'Spare Car'`);
    }
  });

  it('refuses when the driver moved away from the point the offer was measured from', async () => {
    const { offerId } = await offerTo(jashim, nusrat);

    await pool.query(`UPDATE driver_profiles SET current_service_point_id = $2::uuid WHERE id = $1::uuid`, [
      jashim.driverProfile.id,
      points.mid,
    ]);

    await rejectWith(() => acceptAs(jashim)(offerId), 409, /have moved since this offer/);
  });

  it('refuses when the driver already has an active pool', async () => {
    const { offerId } = await offerTo(jashim, nusrat);

    await withRollback(async () => {});
    await pool.query(
      `INSERT INTO ride_pools (driver_profile_id, vehicle_id, status, capacity_snapshot,
                               planned_distance_meters, planned_duration_seconds)
       SELECT $1::uuid, v.id, 'FORMING', 3, 1000, 300
         FROM vehicles v WHERE v.driver_id = $1::uuid AND v.active LIMIT 1`,
      [jashim.driverProfile.id],
    );

    await rejectWith(() => acceptAs(jashim)(offerId), 409, /already have an active ride pool/);
  });

  it('refuses an offer that already expired, and records it as expired rather than accepted', async () => {
    const { request, offerId } = await offerTo(jashim, nusrat);

    const { rows } = await pool.query(`SELECT expires_at FROM dispatch_offers WHERE id = $1::uuid`, [
      offerId,
    ]);
    await dispatch.expireOverdueOffers({ now: new Date(rows[0].expires_at) });

    await rejectWith(() => acceptAs(jashim)(offerId), 409, /expired/);

    const state = await stateOf(request.id);
    assert.strictEqual(state.offer.status, 'EXPIRED');
    assert.strictEqual(state.request.status, 'WAITING');
    assert.deepStrictEqual(await counts(), { pools: 0, members: 0, stops: 0, events: 0 });
  });

  it('refuses the same offer a second time', async () => {
    const { offerId } = await offerTo(jashim, nusrat);
    await acceptAs(jashim)(offerId);

    await rejectWith(() => acceptAs(jashim)(offerId), 409, /already accepted/);

    assert.strictEqual((await counts()).pools, 1, 'no second pool was created');
  });

  it('refuses an offer that has already been rejected', async () => {
    const { request, offerId } = await offerTo(jashim, nusrat);
    await offers.rejectOffer({ driver: jashim, offerId, reason: 'TOO_FAR' });

    await rejectWith(() => acceptAs(jashim)(offerId), 409, /already rejected/);
    assert.strictEqual((await stateOf(request.id)).request.status, 'WAITING');
  });

  it('refuses a passenger who has no driver profile at all', async () => {
    const { offerId } = await offerTo(jashim, nusrat);

    await rejectWith(() => acceptAs(nusrat)(offerId), 403, /Only a driver/);
  });
});

const driverStatusOf = async (driverProfileId) => {
  const { rows } = await pool.query(`SELECT status FROM driver_profiles WHERE id = $1::uuid`, [
    driverProfileId,
  ]);
  return rows[0].status;
};

const loginAs = async (email) => {
  const response = await api.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: env.demoSeedPassword }),
  });
  assert.strictEqual(response.status, 200, `could not sign in as ${email}`);
  return response.setCookie.split(';')[0];
};

describe('concurrency', () => {
  /**
   * The invariant every race must preserve.
   *
   * A ride request is either matched with exactly one pool, or still waiting
   * with none. There is no third state, and in particular there is never both a
   * pool and a cancelled request, nor a matched request without a pool.
   */
  const assertExactlyOneOutcome = async (rideRequestId) => {
    const state = await stateOf(rideRequestId);
    const all = await counts();

    if (state.request.status === 'MATCHED') {
      assert.ok(state.member, 'a matched request must have a pool member');
      assert.strictEqual(all.pools, 1);
      assert.strictEqual(all.members, 1);
      assert.strictEqual(all.stops, 2);
      assert.strictEqual(state.offer.status, 'ACCEPTED');
    } else {
      assert.strictEqual(state.request.status, 'CANCELLED');
      assert.strictEqual(state.member, undefined, 'a cancelled request must have no member');
      assert.strictEqual(all.pools, 0);
      assert.strictEqual(all.members, 0);
      assert.strictEqual(all.stops, 0);
    }

    return state;
  };

  it('lets one of two drivers take a request, and only one', async () => {
    await goOnline(jashim, POINTS.NEAR);
    await goOnline(salauddin, POINTS.MID);

    const request = await requestRide(nusrat);
    const first = await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });
    assert.strictEqual(first.driverProfileId, jashim.driverProfile.id);

    // Jashim refuses, so the request moves on to Salauddin. Both offers now
    // exist for the same ride, and only one of them can still be answered.
    await offers.rejectOffer({ driver: jashim, offerId: first.offerId, reason: 'TOO_FAR' });
    await dispatch.dispatchWaitingRequest({ rideRequestId: request.id });

    const second = await pool.query(
      `SELECT id FROM dispatch_offers WHERE ride_request_id = $1::uuid AND status = 'PENDING'`,
      [request.id],
    );
    const secondOfferId = second.rows[0].id;

    const results = await Promise.allSettled([
      acceptAs(jashim)(first.offerId),
      acceptAs(salauddin)(secondOfferId),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    assert.strictEqual(fulfilled.length, 1, 'exactly one driver takes the ride');

    const rejected = results.filter((result) => result.status === 'rejected');
    assert.strictEqual(rejected[0].reason.statusCode, 409);

    const state = await stateOf(request.id);
    assert.strictEqual(state.request.status, 'MATCHED');
    assert.strictEqual(state.member.ride_pool_id, fulfilled[0].value.pool.id);
    assert.strictEqual((await counts()).pools, 1);
  });

  it('creates one pool when one driver accepts the same offer twice at once', async () => {
    const { request, offerId } = await offerTo(jashim, nusrat);

    const results = await Promise.allSettled([acceptAs(jashim)(offerId), acceptAs(jashim)(offerId)]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    assert.strictEqual(fulfilled.length, 1, `one acceptance may succeed, got ${fulfilled.length}`);

    const all = await counts();
    assert.strictEqual(all.pools, 1);
    assert.strictEqual(all.members, 1);
    assert.strictEqual(all.stops, 2);
    assert.strictEqual((await stateOf(request.id)).request.status, 'MATCHED');

    // The pool events are written once, by the winner.
    assert.strictEqual(all.events, 3);
  });

  it('never produces both a pool and a cancelled request, however it interleaves', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await resetDispatchState();
      const { request, offerId } = await offerTo(jashim, nusrat);

      const results = await Promise.allSettled([
        acceptAs(jashim)(offerId),
        cancelRideRequest({
          passenger: nusrat,
          rideRequestId: request.id,
          reason: 'CHANGED_MIND',
        }),
      ]);

      const state = await assertExactlyOneOutcome(request.id);
      assert.ok(
        ['MATCHED', 'CANCELLED'].includes(state.request.status),
        `attempt ${attempt}: ${state.request.status}`,
      );

      // Exactly one of the two operations wins, and the other is told no.
      const won = results.filter((result) => result.status === 'fulfilled').length;
      assert.ok(won >= 1, `attempt ${attempt}: somebody has to win`);

      if (state.request.status === 'CANCELLED') {
        assert.strictEqual(
          state.offer.status,
          'CANCELLED',
          'a cancelled ride must not leave an offer a driver could still accept',
        );
      }

      const cancelledOffers = await pool.query(
        `SELECT count(*)::int AS count FROM dispatch_offers
          WHERE ride_request_id = $1::uuid AND status = 'PENDING'`,
        [request.id],
      );
      assert.strictEqual(
        cancelledOffers.rows[0].count,
        0,
        'no offer may be left pending on a settled request',
      );
    }
  });

  it('never produces both a pool and an expired offer, however it interleaves', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await resetDispatchState();
      const { request, offerId } = await offerTo(jashim, nusrat);

      const { rows } = await pool.query(`SELECT expires_at FROM dispatch_offers WHERE id = $1::uuid`, [
        offerId,
      ]);

      const results = await Promise.allSettled([
        acceptAs(jashim)(offerId),
        dispatch.expireOverdueOffers({ now: new Date(rows[0].expires_at) }),
      ]);

      const state = await stateOf(request.id);
      const all = await counts();

      if (state.offer.status === 'ACCEPTED') {
        assert.strictEqual(state.request.status, 'MATCHED');
        assert.strictEqual(all.pools, 1);
        assert.strictEqual(all.members, 1);
      } else {
        assert.strictEqual(state.offer.status, 'EXPIRED');
        assert.strictEqual(all.pools, 0, `attempt ${attempt}: an expired offer must make no pool`);
        assert.notStrictEqual(state.request.status, 'MATCHED');
      }

      assert.ok(results.length === 2);
    }
  });

  it('refuses a second pending offer for one driver at the database level', async () => {
    // The service filters this out before it offers anything; the index is what
    // makes it impossible when two dispatchers run at once.
    const first = await offerTo(jashim, nusrat);

    await withRollback(async (tx) => {
      await expectPgError(
        tx,
        () =>
          tx.query(
            `INSERT INTO dispatch_offers (ride_request_id, driver_profile_id, vehicle_id,
                                          approach_distance_meters, approach_duration_seconds,
                                          score, offered_at, expires_at, proposal_snapshot)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 100, 60, 60, now(), now() + interval '30 seconds', '{}')`,
            [fixtures.rafiq.id, jashim.driverProfile.id, jashim.driverProfile.vehicles[0].id],
          ),
        '23505',
      );
    });

    assert.ok(first.offerId);
  });

  it('refuses a second pending offer for one request at the database level', async () => {
    const { request } = await offerTo(jashim, nusrat);

    await withRollback(async (tx) => {
      await expectPgError(
        tx,
        () =>
          tx.query(
            `INSERT INTO dispatch_offers (ride_request_id, driver_profile_id, vehicle_id,
                                          approach_distance_meters, approach_duration_seconds,
                                          score, offered_at, expires_at, proposal_snapshot)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 100, 60, 60, now(), now() + interval '30 seconds', '{}')`,
            [request.id, salauddin.driverProfile.id, salauddin.driverProfile.vehicles[0].id],
          ),
        '23505',
      );
    });
  });

  it('refuses a second active pool for one driver at the database level', async () => {
    await withRollback(async (tx) => {
      await insertPool(tx);

      await expectPgError(tx, () => insertPool(tx), '23505');
      await expectPgError(tx, () => insertPool(tx, { status: 'DRIVER_EN_ROUTE' }), '23505');
    });
  });

  it('allows a driver a new pool once the previous one is finished', async () => {
    await withRollback(async (tx) => {
      await insertPool(tx, { status: 'COMPLETED', completedAt: new Date(), startedAt: new Date() });
      await insertPool(tx);
    });
  });

  it('refuses two members for one ride request', async () => {
    await withRollback(async (tx) => {
      const firstPool = await insertPool(tx);
      const secondPool = await insertPool(tx, {
        status: 'COMPLETED',
        completedAt: new Date(),
        startedAt: new Date(),
      });

      await insertMember(tx, { ridePoolId: firstPool, rideRequestId: fixtures.shirin.id });

      await expectPgError(
        tx,
        () => insertMember(tx, { ridePoolId: secondPool, rideRequestId: fixtures.shirin.id }),
        '23505',
      );
    });
  });
});

describe('the pool is checked as a whole', () => {
  it('refuses a pool with no capacity, no route or a bad version', async () => {
    await withRollback(async (tx) => {
      await expectPgError(tx, () => insertPool(tx, { capacitySnapshot: 0 }), '23514');
      await expectPgError(tx, () => insertPool(tx, { capacitySnapshot: -1 }), '23514');
      await expectPgError(tx, () => insertPool(tx, { plannedDistanceMeters: 0 }), '23514');
      await expectPgError(tx, () => insertPool(tx, { plannedDurationSeconds: 0 }), '23514');
      await expectPgError(tx, () => insertPool(tx, { version: 0 }), '23514');
    });
  });

  it('refuses a pool whose timestamps disagree with its status', async () => {
    await withRollback(async (tx) => {
      // COMPLETED without a completion time is not a finished pool...
      await expectPgError(tx, () => insertPool(tx, { status: 'COMPLETED' }), '23514');
      // ...CANCELLED without one is not a cancelled pool...
      await expectPgError(tx, () => insertPool(tx, { status: 'CANCELLED' }), '23514');
      // ...and an unfinished pool cannot already have started.
      await expectPgError(
        tx,
        () => insertPool(tx, { status: 'FORMING', startedAt: new Date() }),
        '23514',
      );
    });
  });

  it('refuses two stops at one sequence, or two of one type for one member', async () => {
    await withRollback(async (tx) => {
      const ridePoolId = await insertPool(tx);
      const shirinMember = await insertMember(tx, {
        ridePoolId,
        rideRequestId: fixtures.shirin.id,
      });

      await insertStop(tx, {
        ridePoolId,
        rideRequestId: fixtures.shirin.id,
        poolMemberId: shirinMember,
        servicePointId: points.pickup,
        stopType: 'PICKUP',
        sequence: 1,
      });

      await insertStop(tx, {
        ridePoolId,
        rideRequestId: fixtures.shirin.id,
        poolMemberId: shirinMember,
        servicePointId: points.destination,
        stopType: 'DROPOFF',
        sequence: 2,
      });

      // A second passenger planned into position 1 of the same pool: the plan
      // would have two first stops, which is not a plan.
      const rafiqMember = await insertMember(tx, {
        ridePoolId,
        rideRequestId: fixtures.rafiq.id,
      });

      await expectPgError(
        tx,
        () =>
          insertStop(tx, {
            ridePoolId,
            rideRequestId: fixtures.rafiq.id,
            poolMemberId: rafiqMember,
            servicePointId: points.pickup,
            stopType: 'PICKUP',
            sequence: 1,
          }),
        '23505',
      );

      await insertStop(tx, {
        ridePoolId,
        rideRequestId: fixtures.rafiq.id,
        poolMemberId: rafiqMember,
        servicePointId: points.pickup,
        stopType: 'PICKUP',
        sequence: 3,
      });

      // ...and a passenger cannot be collected twice.
      await expectPgError(
        tx,
        () =>
          insertStop(tx, {
            ridePoolId,
            rideRequestId: fixtures.rafiq.id,
            poolMemberId: rafiqMember,
            servicePointId: points.pickup,
            stopType: 'PICKUP',
            sequence: 4,
          }),
        '23505',
      );
    });
  });

  it('refuses a stop that is not the request?s own place', async () => {
    await withRollback(async (tx) => {
      const ridePoolId = await insertPool(tx);
      const poolMemberId = await insertMember(tx, {
        ridePoolId,
        rideRequestId: fixtures.shirin.id,
      });

      // A pickup somewhere other than where the passenger asked to be collected.
      await expectPgError(
        tx,
        () =>
          insertStop(tx, {
            ridePoolId,
            rideRequestId: fixtures.shirin.id,
            poolMemberId,
            servicePointId: points.mid,
            stopType: 'PICKUP',
            sequence: 1,
          }),
        '23514',
      );

      // A drop-off somewhere other than their destination.
      await expectPgError(
        tx,
        () =>
          insertStop(tx, {
            ridePoolId,
            rideRequestId: fixtures.shirin.id,
            poolMemberId,
            servicePointId: points.mid,
            stopType: 'DROPOFF',
            sequence: 2,
          }),
        '23514',
      );
    });
  });

  it('refuses a drop-off that comes before its pickup', async () => {
    await withRollback(async (tx) => {
      const ridePoolId = await insertPool(tx);
      const poolMemberId = await insertMember(tx, {
        ridePoolId,
        rideRequestId: fixtures.shirin.id,
      });

      await expectPgError(
        tx,
        () =>
          insertStop(tx, {
            ridePoolId,
            rideRequestId: fixtures.shirin.id,
            poolMemberId,
            servicePointId: points.destination,
            stopType: 'DROPOFF',
            sequence: 1,
          }),
        '23514',
      );
    });
  });

  it('refuses a stop whose member belongs to another pool or request', async () => {
    await withRollback(async (tx) => {
      const ridePoolId = await insertPool(tx);
      const poolMemberId = await insertMember(tx, {
        ridePoolId,
        rideRequestId: fixtures.shirin.id,
      });

      // The same member, but claimed for somebody else's ride request.
      await expectPgError(
        tx,
        () =>
          insertStop(tx, {
            ridePoolId,
            rideRequestId: fixtures.rafiq.id,
            poolMemberId,
            servicePointId: points.pickup,
            stopType: 'PICKUP',
            sequence: 1,
          }),
        '23514',
      );
    });
  });

  it('refuses a non-positive, duplicated or non-object pool event', async () => {
    await withRollback(async (tx) => {
      const ridePoolId = await insertPool(tx);
      const insert = (sequenceNumber, metadata = '{}') =>
        tx.query(
          `INSERT INTO pool_events (ride_pool_id, sequence, event_type, actor_type, metadata)
           VALUES ($1::uuid, $2, 'POOL_CREATED', 'SYSTEM', $3::jsonb)`,
          [ridePoolId, sequenceNumber, metadata],
        );

      await insert(1);
      await expectPgError(tx, () => insert(1), '23505');
      await expectPgError(tx, () => insert(0), '23514');
      await expectPgError(tx, () => insert(-1), '23514');
      await expectPgError(tx, () => insert(2, '[]'), '23514');
    });
  });

  it('refuses any update of a pool event', async () => {
    await withRollback(async (tx) => {
      const ridePoolId = await insertPool(tx);
      await tx.query(
        `INSERT INTO pool_events (ride_pool_id, sequence, event_type, actor_type)
         VALUES ($1::uuid, 1, 'POOL_CREATED', 'SYSTEM')`,
        [ridePoolId],
      );

      const errored = await expectPgError(
        tx,
        () =>
          tx.query(`UPDATE pool_events SET metadata = '{"edited":true}' WHERE ride_pool_id = $1::uuid`, [
            ridePoolId,
          ]),
        '23514',
      );

      assert.match(errored.message, /append-only/);
    });
  });

  it('refuses to delete a request or a vehicle that a pool still needs', async () => {
    await withRollback(async (tx) => {
      const ridePoolId = await insertPool(tx);
      await insertMember(tx, { ridePoolId, rideRequestId: fixtures.shirin.id });

      // A request the pool was built around cannot be deleted...
      await expectPgError(
        tx,
        () => tx.query(`DELETE FROM ride_requests WHERE id = $1::uuid`, [fixtures.shirin.id]),
        '23503',
      );

      // ...and neither can the vehicle whose capacity the pool recorded.
      await expectPgError(
        tx,
        () => tx.query(`DELETE FROM vehicles WHERE id = $1::uuid`, [jashim.driverProfile.vehicles[0].id]),
        '23503',
      );
    });
  });

  it('takes the member and stops with the pool when it goes', async () => {
    await withRollback(async (tx) => {
      const ridePoolId = await insertPool(tx);
      const poolMemberId = await insertMember(tx, {
        ridePoolId,
        rideRequestId: fixtures.shirin.id,
      });
      await insertStop(tx, {
        ridePoolId,
        rideRequestId: fixtures.shirin.id,
        poolMemberId,
        servicePointId: points.pickup,
        stopType: 'PICKUP',
        sequence: 1,
      });

      await tx.query(`DELETE FROM ride_pools WHERE id = $1::uuid`, [ridePoolId]);

      const { rows } = await tx.query(
        `SELECT (SELECT count(*)::int FROM pool_members WHERE ride_pool_id = $1::uuid) AS members,
                (SELECT count(*)::int FROM pool_stops   WHERE ride_pool_id = $1::uuid) AS stops`,
        [ridePoolId],
      );
      assert.deepStrictEqual(rows[0], { members: 0, stops: 0 });
    });
  });
});

describe('the offer record is evidence', () => {
  it('refuses an update of the driver, request, vehicle, approach, score or proposal', async () => {
    const { offerId } = await offerTo(jashim, nusrat);

    const frozen = [
      ['driver_profile_id', `driver_profile_id = $2`, [salauddin.driverProfile.id]],
      ['ride_request_id', `ride_request_id = $2`, [fixtures.rafiq.id]],
      ['vehicle_id', `vehicle_id = $2`, [salauddin.driverProfile.vehicles[0].id]],
      ['approach_distance_meters', `approach_distance_meters = 1`, []],
      ['approach_duration_seconds', `approach_duration_seconds = 1`, []],
      ['score', `score = 1`, []],
      ['offered_at', `offered_at = offered_at - interval '1 hour'`, []],
      ['expires_at', `expires_at = expires_at + interval '1 hour'`, []],
      ['proposal_snapshot', `proposal_snapshot = '{"tampered":true}'::jsonb`, []],
    ];

    await withRollback(async (tx) => {
      for (const [column, assignment, extra] of frozen) {
        const errored = await expectPgError(
          tx,
          () => tx.query(`UPDATE dispatch_offers SET ${assignment} WHERE id = $1::uuid`, [offerId, ...extra]),
          '23514',
        );

        assert.match(errored.message, /immutable/, column);
      }
    });

    // Nothing any of those attempts touched survived, and the offer is intact.
    const { rows } = await pool.query(
      `SELECT driver_profile_id, vehicle_id, status, score::text AS score
         FROM dispatch_offers WHERE id = $1::uuid`,
      [offerId],
    );
    assert.strictEqual(rows[0].driver_profile_id, jashim.driverProfile.id);
    assert.strictEqual(rows[0].vehicle_id, jashim.driverProfile.vehicles[0].id);
    assert.strictEqual(rows[0].status, 'PENDING');
    assert.notStrictEqual(rows[0].score, '1.00');
  });

  it('keeps a terminal offer final', async () => {
    const { offerId } = await offerTo(jashim, nusrat);
    await offers.rejectOffer({ driver: jashim, offerId, reason: 'OTHER' });

    await withRollback(async (tx) => {
      // A refusal is final: the driver cannot come back and accept it, and the
      // dispatcher cannot quietly revive it either.
      for (const status of ['ACCEPTED', 'PENDING', 'EXPIRED', 'CANCELLED']) {
        const errored = await expectPgError(
          tx,
          () => tx.query(`UPDATE dispatch_offers SET status = $2 WHERE id = $1::uuid`, [offerId, status]),
          '23514',
        );

        assert.match(errored.message, /illegal dispatch offer transition/);
      }
    });

    const { rows } = await pool.query(`SELECT status FROM dispatch_offers WHERE id = $1::uuid`, [
      offerId,
    ]);
    assert.strictEqual(rows[0].status, 'REJECTED');
  });

  it('refuses a rejection with no reason, or a reason on an offer that was not rejected', async () => {
    const { offerId } = await offerTo(jashim, nusrat);

    await withRollback(async (tx) => {
      // A refusal always says why...
      for (const assignment of [
        `status = 'REJECTED', responded_at = now()`,
        `status = 'REJECTED', responded_at = now(), rejection_reason = 'OTHER'`,
      ]) {
        if (assignment.includes('rejection_reason')) continue;
        await expectPgError(
          tx,
          () => tx.query(`UPDATE dispatch_offers SET ${assignment} WHERE id = $1::uuid`, [offerId]),
          '23514',
        );
      }

      // ...no other ending carries a reason...
      await expectPgError(
        tx,
        () =>
          tx.query(
            `UPDATE dispatch_offers SET status = 'EXPIRED', responded_at = now(),
                    rejection_reason = 'TOO_FAR' WHERE id = $1::uuid`,
            [offerId],
          ),
        '23514',
      );

      // ...a terminal offer always carries a response time...
      await expectPgError(
        tx,
        () => tx.query(`UPDATE dispatch_offers SET status = 'CANCELLED' WHERE id = $1::uuid`, [offerId]),
        '23514',
      );

      // ...and an offer cannot be pointed at a pool before it was accepted: a
      // pool exists because an offer was accepted, not the other way round.
      const ridePoolId = await insertPool(tx);
      await expectPgError(
        tx,
        () =>
          tx.query(`UPDATE dispatch_offers SET ride_pool_id = $2::uuid WHERE id = $1::uuid`, [
            offerId,
            ridePoolId,
          ]),
        '23514',
      );
    });
  });
});

