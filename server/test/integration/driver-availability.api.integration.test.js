import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import { startApiServer } from '../helpers/api-server.js';
import { closePool, pool, prepareDatabase } from '../helpers/db.js';
import {
  createTestDriver,
  goOnline,
  loadDemoUser,
  POINTS,
  removeTestDriver,
  resetDispatchState,
} from '../helpers/drivers.js';

/**
 * Driver availability over HTTP: the four driver endpoints, and the rules behind
 * going online, moving and going offline.
 *
 * The suite drives the real Express app against the real database, so what it
 * proves is the contract a driver's client actually gets. Where a test needs a
 * second driver it creates one rather than changing the demo cast, which other
 * suites assert on.
 */

const AVAILABILITY_KEYS = [
  'availableSince',
  'canGoOffline',
  'canGoOnline',
  'currentServicePoint',
  'driverProfileId',
  'lastSeenAt',
  'status',
  'updatedAt',
  'vehicle',
  'vehicles',
].sort();

let api;
let jashim;
let jashimCookie;
let nusratCookie;
/** A second driver, created here and removed afterwards. */
let other;

const jsonBody = (body, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const login = async (email) => {
  const response = await api.request(
    '/auth/login',
    jsonBody({ email, password: env.demoSeedPassword }),
  );
  assert.strictEqual(response.status, 200, `could not sign in as ${email}`);
  return response.setCookie.split(';')[0];
};

/** A request as the driver, with the session cookie attached. */
const asDriver = (path, options = {}) => {
  const { method = 'GET', body, cookie = jashimCookie } = options;
  return api.request(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
};

const online = (code, extra = {}) =>
  asDriver('/drivers/me/online', {
    ...extra,
    method: 'POST',
    body: { currentServicePointCode: code, ...(extra.body ?? {}) },
  });

const statusOf = async (driverProfileId) => {
  const { rows } = await pool.query(
    `SELECT status, current_service_point_id, available_since, last_seen_at, active_vehicle_id
       FROM driver_profiles WHERE id = $1::uuid`,
    [driverProfileId],
  );
  return rows[0];
};

const setBulletActive = (active) =>
  pool.query(`UPDATE vehicles SET active = $1 WHERE name = 'Bullet'`, [active]);

before(async () => {
  await prepareDatabase();
  api = await startApiServer();

  jashim = await loadDemoUser('jashim@example.com');
  jashimCookie = await login('jashim@example.com');
  nusratCookie = await login('nusrat@example.com');

  other = await createTestDriver({ name: 'Other Driver', vehicleName: 'Other Car' });
});

beforeEach(async () => {
  await resetDispatchState();
});

after(async () => {
  await removeTestDriver(other.email);
  await resetDispatchState();
  await api?.close();
  await closePool();
});

describe('authentication and authorization', () => {
  it('rejects every driver endpoint without a session', async () => {
    const endpoints = [
      { method: 'GET', path: '/drivers/me/availability' },
      { method: 'POST', path: '/drivers/me/online' },
      { method: 'POST', path: '/drivers/me/offline' },
      { method: 'PUT', path: '/drivers/me/current-service-point' },
      { method: 'GET', path: '/drivers/me/offers' },
      { method: 'GET', path: '/drivers/me/pool' },
    ];

    for (const { method, path } of endpoints) {
      const response = await api.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });

      assert.strictEqual(response.status, 401, `${method} ${path}`);
      assert.match(response.body.error.message, /Authentication required/);
    }
  });

  it('keeps a passenger out with 403, not with a missing resource', async () => {
    const endpoints = [
      { method: 'GET', path: '/drivers/me/availability', body: null },
      { method: 'POST', path: '/drivers/me/online', body: { currentServicePointCode: POINTS.NEAR } },
      { method: 'POST', path: '/drivers/me/offline', body: {} },
      { method: 'PUT', path: '/drivers/me/current-service-point', body: { currentServicePointCode: POINTS.NEAR } },
      { method: 'GET', path: '/drivers/me/offers', body: null },
      { method: 'POST', path: '/drivers/me/offers/00000000-0000-4000-8000-000000000000/accept', body: {} },
      { method: 'POST', path: '/drivers/me/offers/00000000-0000-4000-8000-000000000000/reject', body: { reason: 'OTHER' } },
      { method: 'GET', path: '/drivers/me/pool', body: null },
    ];

    for (const { method, path, body } of endpoints) {
      const response = await api.request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          cookie: nusratCookie,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      assert.strictEqual(response.status, 403, `${method} ${path}`);
      assert.match(response.body.error.message, /do not have access/i);
    }
  });

  it('leaves an unknown path under /drivers as a 404', async () => {
    // The guards are mounted per route, so a path that does not exist is not
    // revealed as "exists but forbidden".
    for (const path of ['/drivers', '/drivers/me', '/drivers/me/nothing']) {
      const response = await asDriver(path);
      assert.strictEqual(response.status, 404, path);
    }
  });
});

describe('going online', () => {
  it('puts Jashim online at Banani Kakoli with his vehicle', async () => {
    const response = await online(POINTS.NEAR);

    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.deepStrictEqual(Object.keys(response.body).sort(), AVAILABILITY_KEYS);

    assert.strictEqual(response.body.status, 'AVAILABLE');
    assert.strictEqual(response.body.driverProfileId, jashim.driverProfile.id);
    assert.deepStrictEqual(response.body.currentServicePoint, {
      code: 'banani-kakoli',
      name: 'Banani Kakoli',
    });
    assert.deepStrictEqual(response.body.vehicle, {
      vehicleId: jashim.driverProfile.vehicles[0].id,
      name: 'Bullet',
      seatCapacity: 3,
    });
    assert.ok(response.body.availableSince);
    assert.ok(response.body.lastSeenAt);
    assert.strictEqual(response.body.canGoOffline, true);

    // ...and it is the stored state, not just the response.
    const stored = await statusOf(jashim.driverProfile.id);
    assert.strictEqual(stored.status, 'AVAILABLE');
    assert.ok(stored.current_service_point_id);
    assert.ok(stored.active_vehicle_id);
  });

  it('is idempotent, and re-reporting does not reset the idle clock', async () => {
    const first = await online(POINTS.NEAR);
    const second = await online(POINTS.NEAR);

    assert.strictEqual(second.status, 200);
    // availableSince is when the driver became available, so a refresh must not
    // give them the credit back (or take it away).
    assert.strictEqual(second.body.availableSince, first.body.availableSince);
    assert.strictEqual(second.body.status, 'AVAILABLE');
  });

  it('refreshes lastSeenAt when the driver moves', async () => {
    const first = await online(POINTS.NEAR);
    const moved = await asDriver('/drivers/me/current-service-point', {
      method: 'PUT',
      body: { currentServicePointCode: POINTS.MID },
    });

    assert.strictEqual(moved.status, 200);
    assert.deepStrictEqual(moved.body.currentServicePoint, {
      code: 'gulshan-2-circle',
      name: 'Gulshan 2 Circle',
    });
    assert.ok(
      new Date(moved.body.lastSeenAt).getTime() >= new Date(first.body.lastSeenAt).getTime(),
      'a move is also a report of where the driver is',
    );
    assert.strictEqual(moved.body.availableSince, first.body.availableSince);
  });

  it('requires an active vehicle', async () => {
    await pool.query(`UPDATE vehicles SET active = false WHERE name = 'Bullet'`);
    try {
      const response = await online(POINTS.NEAR);

      assert.strictEqual(response.status, 409);
      assert.match(response.body.error.message, /active vehicle/i);
    } finally {
      await pool.query(`UPDATE vehicles SET active = true WHERE name = 'Bullet'`);
    }
  });

  it('refuses a driver with no vehicle at all', async () => {
    const { id } = await pool.query(`SELECT id FROM vehicles WHERE name = 'Bullet'`).then((r) => r.rows[0]);
    await pool.query(`UPDATE vehicles SET active = false WHERE id = $1::uuid`, [id]);
    await pool.query(`DELETE FROM vehicles WHERE id = $1::uuid`, [id]);

    try {
      const driver = await loadDemoUser('jashim@example.com');
      await assert.rejects(
        () => goOnline(driver, POINTS.NEAR),
        (err) => {
          assert.strictEqual(err.statusCode, 409);
          assert.match(err.message, /needs a vehicle/i);
          return true;
        },
      );
    } finally {
      await pool.query(
        `INSERT INTO vehicles (driver_id, name, seat_capacity, active)
         SELECT id, 'Bullet', 3, true FROM driver_profiles WHERE user_id = $1::uuid`,
        [jashim.id],
      );
    }
  });

  it('requires an active service point', async () => {
    const unknown = await online('not-a-real-point');
    assert.strictEqual(unknown.status, 404);
    assert.match(unknown.body.error.message, /was not found/);

    await pool.query(`UPDATE service_points SET active = false WHERE code = $1`, [POINTS.NEAR]);
    try {
      const inactive = await online(POINTS.NEAR);
      assert.strictEqual(inactive.status, 409);
      assert.match(inactive.body.error.message, /not accepting rides/);
    } finally {
      await pool.query(`UPDATE service_points SET active = true WHERE code = $1`, [POINTS.NEAR]);
    }
  });

  it('refuses a malformed or missing point code before it touches the database', async () => {
    for (const body of [{}, { currentServicePointCode: '' }, { currentServicePointCode: 'UPPER CASE' }, { currentServicePointCode: 42 }]) {
      const response = await asDriver('/drivers/me/online', { method: 'POST', body });

      assert.strictEqual(response.status, 400, JSON.stringify(body));
      assert.match(response.body.error.message, /currentServicePointCode/);
    }
  });

  it('makes a driver with several vehicles choose, and refuses a vehicle that is not theirs', async () => {
    await pool.query(
      `INSERT INTO vehicles (driver_id, name, seat_capacity, active)
       SELECT id, 'Second Car', 2, true FROM driver_profiles WHERE user_id = $1::uuid`,
      [jashim.id],
    );

    try {
      // Two usable vehicles and no choice made: the driver is asked, rather than
      // having one picked for them.
      const ambiguous = await online(POINTS.NEAR);
      assert.strictEqual(ambiguous.status, 409);
      assert.match(ambiguous.body.error.message, /more than one active vehicle/);

      const { rows } = await pool.query(
        `SELECT v.id, v.name FROM vehicles v JOIN driver_profiles dp ON dp.id = v.driver_id
          WHERE dp.user_id = $1::uuid ORDER BY v.name`,
        [jashim.id],
      );
      const second = rows.find((row) => row.name === 'Second Car');

      // The list of choices is in the availability DTO, so a client can pick.
      const listed = await asDriver('/drivers/me/availability');
      assert.deepStrictEqual(
        listed.body.vehicles.map((vehicle) => vehicle.name),
        ['Bullet', 'Second Car'],
      );

      const chosen = await online(POINTS.NEAR, { body: { vehicleId: second.id } });
      assert.strictEqual(chosen.status, 200);
      assert.strictEqual(chosen.body.vehicle.name, 'Second Car');
      assert.strictEqual((await statusOf(jashim.driverProfile.id)).active_vehicle_id, second.id);

      // And going online again remembers the choice instead of asking again.
      const again = await online(POINTS.MID);
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.body.vehicle.name, 'Second Car');

      // A vehicle belonging to somebody else is not a way in.
      const stolen = await online(POINTS.NEAR, {
        body: { vehicleId: other.driverProfile.vehicles[0].id },
      });
      assert.strictEqual(stolen.status, 404);
      assert.strictEqual((await statusOf(jashim.driverProfile.id)).active_vehicle_id, second.id);
    } finally {
      await pool.query(`DELETE FROM vehicles WHERE name = 'Second Car'`);
    }
  });

  it('refuses a body field it does not understand', async () => {
    for (const body of [
      { currentServicePointCode: POINTS.NEAR, driverProfileId: other.driverProfile.id },
      { currentServicePointCode: POINTS.NEAR, status: 'AVAILABLE' },
      { currentServicePointCode: POINTS.NEAR, latitude: 23.79 },
    ]) {
      const response = await asDriver('/drivers/me/online', { method: 'POST', body });

      assert.strictEqual(response.status, 400, JSON.stringify(body));
      assert.match(response.body.error.message, /Unsupported body field/);
    }
  });
});

describe('another driver', () => {
  it('cannot be named by Jashim, and is untouched by Jashim going online', async () => {
    const before = await statusOf(other.driverProfile.id);

    const response = await online(POINTS.NEAR);
    assert.strictEqual(response.status, 200);

    // The only driver an operator of these endpoints can reach is themselves:
    // there is no field, no path and no query parameter that names another
    // driver, and "me" is resolved from the session.
    for (const attempt of [
      { path: `/drivers/me/availability?driverProfileId=${other.driverProfile.id}`, method: 'GET' },
      { path: `/drivers/${other.driverProfile.id}/availability`, method: 'GET' },
      { path: `/drivers/me/${other.driverProfile.id}/offline`, method: 'POST' },
    ]) {
      const refused = await asDriver(attempt.path, {
        method: attempt.method,
        ...(attempt.method === 'GET' ? {} : { body: {} }),
      });
      assert.ok([400, 404].includes(refused.status), `${attempt.path} -> ${refused.status}`);
    }

    assert.deepStrictEqual(await statusOf(other.driverProfile.id), before);
    assert.notStrictEqual(response.body.driverProfileId, other.driverProfile.id);
    assert.strictEqual(response.body.driverProfileId, jashim.driverProfile.id);
  });
});

describe('going offline', () => {
  it('clears the location and the availability clock', async () => {
    await online(POINTS.NEAR);

    const response = await asDriver('/drivers/me/offline', { method: 'POST', body: {} });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.status, 'OFFLINE');
    assert.strictEqual(response.body.availableSince, null);
    assert.strictEqual(response.body.canGoOffline, false);
    assert.strictEqual(response.body.canGoOnline, true);

    const stored = await statusOf(jashim.driverProfile.id);
    assert.strictEqual(stored.status, 'OFFLINE');
    assert.strictEqual(stored.available_since, null);
    // The point is kept: it is where the driver is, and where they will come
    // back online from. Being offline is not the same as being nowhere.
    assert.ok(stored.current_service_point_id);
  });

  it('is idempotent, so a retry is not an error', async () => {
    const first = await asDriver('/drivers/me/offline', { method: 'POST', body: {} });
    const second = await asDriver('/drivers/me/offline', { method: 'POST', body: {} });

    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.status, 'OFFLINE');
  });

  it('refuses a reserved driver, because they are committed to a passenger', async () => {
    await online(POINTS.NEAR);
    await pool.query(`UPDATE driver_profiles SET status = 'RESERVED' WHERE id = $1::uuid`, [
      jashim.driverProfile.id,
    ]);

    const response = await asDriver('/drivers/me/offline', { method: 'POST', body: {} });

    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /RESERVED cannot go offline/);
    assert.strictEqual((await statusOf(jashim.driverProfile.id)).status, 'RESERVED');
  });

  it('refuses to let an on-ride driver go offline as well', async () => {
    await online(POINTS.NEAR);
    await pool.query(`UPDATE driver_profiles SET status = 'ON_RIDE' WHERE id = $1::uuid`, [
      jashim.driverProfile.id,
    ]);

    const response = await asDriver('/drivers/me/offline', { method: 'POST', body: {} });

    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /ON_RIDE cannot go offline/);
  });

  it('refuses to let a committed driver move', async () => {
    await online(POINTS.NEAR);
    await pool.query(`UPDATE driver_profiles SET status = 'RESERVED' WHERE id = $1::uuid`, [
      jashim.driverProfile.id,
    ]);

    const response = await asDriver('/drivers/me/current-service-point', {
      method: 'PUT',
      body: { currentServicePointCode: POINTS.MID },
    });

    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /cannot change their current service point/);
  });

  it('refuses a reserved driver trying to come back online', async () => {
    await online(POINTS.NEAR);
    await pool.query(`UPDATE driver_profiles SET status = 'RESERVED' WHERE id = $1::uuid`, [
      jashim.driverProfile.id,
    ]);

    const response = await online(POINTS.MID);

    assert.strictEqual(response.status, 409);
    assert.match(response.body.error.message, /RESERVED cannot go online/);
  });
});

describe('reading availability', () => {
  it('reports an offline driver who has never been online', async () => {
    const response = await asDriver('/drivers/me/availability');

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(Object.keys(response.body).sort(), AVAILABILITY_KEYS);
    assert.strictEqual(response.body.status, 'OFFLINE');
    assert.strictEqual(response.body.currentServicePoint, null);
    assert.strictEqual(response.body.vehicle, null);
    assert.strictEqual(response.body.availableSince, null);
    assert.strictEqual(response.body.canGoOnline, true);
    assert.strictEqual(response.body.canGoOffline, false);
    assert.deepStrictEqual(response.body.vehicles.map((v) => v.name), ['Bullet']);
  });

  it('tells the driver their own profile and never their login details', async () => {
    const response = await asDriver('/drivers/me/availability');
    const serialized = JSON.stringify(response.body);

    assert.strictEqual(response.body.driverProfileId, jashim.driverProfile.id);
    assert.ok(!serialized.includes('jashim@example.com'));
    assert.ok(!serialized.includes(jashim.id));
  });

  it('does not reveal another driver?s state through the query string', async () => {
    const response = await asDriver(
      `/drivers/me/availability?driverProfileId=${other.driverProfile.id}`,
    );

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error.message, /Unsupported query parameter/);
  });
});
