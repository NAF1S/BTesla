import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startApiServer } from '../helpers/api-server.js';
import { closePool, pool, prepareDatabase } from '../helpers/db.js';

/**
 * End-to-end tests for the transport-network read endpoints, driven through
 * the real Express app over HTTP against the real PostgreSQL database.
 *
 * Requirements: `npm run db:up` (PostgreSQL reachable via DATABASE_URL).
 * The suite applies server/db/*.sql and the seed itself, and cleans up the one
 * test-only row it creates.
 */

const NORTHBOUND_CORRIDOR = 'northbound-demo';

/** Literal expectation of the demo corridor order, independent of the data file. */
const EXPECTED_CORRIDOR_ORDER = [
  'banani-road-11',
  'banani-kakoli',
  'banani-chairman-bari',
  'gulshan-1',
  'mohakhali-wireless-gate',
  'mohakhali-bus-terminal',
];

const ALL_STOP_CODES = [...EXPECTED_CORRIDOR_ORDER].sort();

/** Existing but switched off; created here so "inactive is rejected" is provable. */
const INACTIVE_STOP_CODE = 'test-inactive-stop';

let api;

before(async () => {
  await prepareDatabase();

  await pool.query(
    `INSERT INTO stops (zone_id, code, name, active)
     SELECT id, $1, 'Test Inactive Stop', false FROM zones WHERE code = 'banani'
     ON CONFLICT (code) DO UPDATE SET active = false, name = EXCLUDED.name`,
    [INACTIVE_STOP_CODE],
  );

  api = await startApiServer();
});

after(async () => {
  await pool.query(`DELETE FROM stops WHERE code = $1`, [INACTIVE_STOP_CODE]);
  await api?.close();
  await closePool();
});

describe('GET /api/transport/zones', () => {
  it('lists active zones as DTOs without internal timestamps', async () => {
    const { status, body } = await api.request('/transport/zones');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      body.data.map((zone) => zone.code),
      ['banani', 'gulshan', 'mohakhali'],
    );
    for (const zone of body.data) {
      assert.deepStrictEqual(Object.keys(zone).sort(), ['code', 'id', 'name']);
    }
  });
});

describe('GET /api/transport/stops', () => {
  it('lists active stops, excluding the inactive one', async () => {
    const { status, body } = await api.request('/transport/stops');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      body.data.map((stop) => stop.code),
      [
        'banani-chairman-bari',
        'banani-kakoli',
        'banani-road-11',
        'gulshan-1',
        'mohakhali-bus-terminal',
        'mohakhali-wireless-gate',
      ],
    );
    assert.ok(!body.data.some((stop) => stop.code === INACTIVE_STOP_CODE));
  });

  it('does not leak created_at / updated_at', async () => {
    const { body } = await api.request('/transport/stops');

    for (const stop of body.data) {
      assert.deepStrictEqual(Object.keys(stop).sort(), [
        'code',
        'id',
        'latitude',
        'longitude',
        'name',
        'zoneCode',
      ]);
    }
  });

  it('filters stops by zone code', async () => {
    const { status, body } = await api.request('/transport/stops?zoneCode=banani');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      body.data.map((stop) => stop.code),
      ['banani-chairman-bari', 'banani-kakoli', 'banani-road-11'],
    );
    assert.ok(body.data.every((stop) => stop.zoneCode === 'banani'));

    const gulshan = await api.request('/transport/stops?zoneCode=gulshan');
    assert.deepStrictEqual(
      gulshan.body.data.map((stop) => stop.code),
      ['gulshan-1'],
    );

    const mohakhali = await api.request('/transport/stops?zoneCode=mohakhali');
    assert.deepStrictEqual(
      mohakhali.body.data.map((stop) => stop.code),
      ['mohakhali-bus-terminal', 'mohakhali-wireless-gate'],
    );
  });

  it('accepts a zone code in any case', async () => {
    const { status, body } = await api.request('/transport/stops?zoneCode=BANANI');

    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.length, 3);
  });

  it('returns 404 for an unknown zone code', async () => {
    const { status, body } = await api.request('/transport/stops?zoneCode=nowhere');

    assert.strictEqual(status, 404);
    assert.match(body.error.message, /nowhere/);
  });

  it('returns 400 for an empty or malformed zone code', async () => {
    const empty = await api.request('/transport/stops?zoneCode=');
    assert.strictEqual(empty.status, 400);

    const malformed = await api.request('/transport/stops?zoneCode=not%20a%20code!');
    assert.strictEqual(malformed.status, 400);
    assert.ok(malformed.body.error.message.includes('zoneCode'));
  });

  it('returns 400 for repeated or unsupported query parameters', async () => {
    const repeated = await api.request('/transport/stops?zoneCode=banani&zoneCode=gulshan');
    assert.strictEqual(repeated.status, 400);

    const unsupported = await api.request('/transport/stops?zoneId=banani');
    assert.strictEqual(unsupported.status, 400);
    assert.match(unsupported.body.error.message, /zoneId/);
  });
});

describe('GET /api/transport/stops/:code', () => {
  it('returns one stop by code with numeric coordinates', async () => {
    const { status, body } = await api.request('/transport/stops/banani-road-11');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.data, {
      id: body.data.id,
      code: 'banani-road-11',
      name: 'Banani Road 11',
      zoneCode: 'banani',
      latitude: 23.7937,
      longitude: 90.4043,
    });
    assert.strictEqual(typeof body.data.latitude, 'number');
  });

  it('returns 404 for an unknown stop code', async () => {
    const { status, body } = await api.request('/transport/stops/no-such-stop');

    assert.strictEqual(status, 404);
    assert.match(body.error.message, /no-such-stop/);
  });

  it('returns 409 for an inactive stop', async () => {
    const { status, body } = await api.request(`/transport/stops/${INACTIVE_STOP_CODE}`);

    assert.strictEqual(status, 409);
    assert.match(body.error.message, /inactive/);
  });

  it('returns 400 for a malformed stop code', async () => {
    const { status } = await api.request('/transport/stops/Not%20A%20Code!');

    assert.strictEqual(status, 400);
  });
});

describe('GET /api/transport/corridors', () => {
  it('lists active corridors as DTOs', async () => {
    const { status, body } = await api.request('/transport/corridors');

    assert.strictEqual(status, 200);
    assert.ok(body.data.some((corridor) => corridor.code === NORTHBOUND_CORRIDOR));
    for (const corridor of body.data) {
      assert.deepStrictEqual(Object.keys(corridor).sort(), ['code', 'id', 'name']);
    }
  });

  it('returns a corridor with its stops ordered by position', async () => {
    const { status, body } = await api.request(`/transport/corridors/${NORTHBOUND_CORRIDOR}`);

    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.code, NORTHBOUND_CORRIDOR);
    assert.deepStrictEqual(
      body.data.stops.map((stop) => stop.code),
      EXPECTED_CORRIDOR_ORDER,
    );
    assert.deepStrictEqual(
      body.data.stops.map((stop) => stop.position),
      [1, 2, 3, 4, 5, 6],
    );
  });

  it('returns 404 for an unknown corridor code', async () => {
    const { status, body } = await api.request('/transport/corridors/no-such-corridor');

    assert.strictEqual(status, 404);
    assert.match(body.error.message, /no-such-corridor/);
  });
});

describe('GET /api/transport/corridors/match', () => {
  it('matches Banani Road 11 -> Mohakhali Bus Terminal on the demo corridor', async () => {
    const { status, body } = await api.request(
      '/transport/corridors/match?pickupStopCode=banani-road-11&dropoffStopCode=mohakhali-bus-terminal',
    );

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      body.data.map((match) => match.corridor.code),
      [NORTHBOUND_CORRIDOR],
    );
    assert.strictEqual(body.data[0].pickupPosition, 1);
    assert.strictEqual(body.data[0].dropoffPosition, 6);
  });

  it('does not match the reversed journey against the one-way corridor', async () => {
    const { status, body } = await api.request(
      '/transport/corridors/match?pickupStopCode=mohakhali-bus-terminal&dropoffStopCode=banani-road-11',
    );

    assert.strictEqual(status, 200);
    assert.ok(
      !body.data.some((match) => match.corridor.code === NORTHBOUND_CORRIDOR),
      'the one-way demo corridor must not match the reversed pair',
    );
    for (const match of body.data) {
      assert.ok(match.pickupPosition < match.dropoffPosition);
    }
  });

  it('matches a middle segment of the corridor', async () => {
    const { status, body } = await api.request(
      '/transport/corridors/match?pickupStopCode=gulshan-1&dropoffStopCode=mohakhali-wireless-gate',
    );

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      body.data.map((match) => [match.corridor.code, match.pickupPosition, match.dropoffPosition]),
      [[NORTHBOUND_CORRIDOR, 4, 5]],
    );
  });

  it('returns 400 when a stop code is missing, identical or unsupported params are used', async () => {
    const missing = await api.request('/transport/corridors/match?pickupStopCode=banani-road-11');
    assert.strictEqual(missing.status, 400);
    assert.match(missing.body.error.message, /dropoffStopCode/);

    const identical = await api.request(
      '/transport/corridors/match?pickupStopCode=banani-road-11&dropoffStopCode=banani-road-11',
    );
    assert.strictEqual(identical.status, 400);

    const unsupported = await api.request(
      '/transport/corridors/match?pickupStopCode=banani-road-11&dropoffStopCode=gulshan-1&zoneCode=banani',
    );
    assert.strictEqual(unsupported.status, 400);
  });

  it('rejects unknown and inactive stops', async () => {
    const unknown = await api.request(
      '/transport/corridors/match?pickupStopCode=no-such-stop&dropoffStopCode=gulshan-1',
    );
    assert.strictEqual(unknown.status, 404);

    const inactive = await api.request(
      `/transport/corridors/match?pickupStopCode=${INACTIVE_STOP_CODE}&dropoffStopCode=gulshan-1`,
    );
    assert.strictEqual(inactive.status, 409);
  });
});

describe('GET /api/transport/travel-estimates', () => {
  it('returns the direct estimate for a seeded demo trip', async () => {
    const { status, body } = await api.request(
      '/transport/travel-estimates?fromStopCode=banani-road-11&toStopCode=gulshan-1',
    );

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.data, {
      fromStop: { code: 'banani-road-11', name: 'Banani Road 11' },
      toStop: { code: 'gulshan-1', name: 'Gulshan 1' },
      estimatedMinutes: 18,
      estimatedDistanceKm: 5.4,
      baseFare: 165,
      currency: 'BDT',
    });
  });

  it('returns the estimate for the full demo trip', async () => {
    const { status, body } = await api.request(
      '/transport/travel-estimates?fromStopCode=banani-road-11&toStopCode=mohakhali-bus-terminal',
    );

    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.estimatedMinutes, 32);
    assert.strictEqual(body.data.baseFare, 290);
  });

  it('does not treat a directional estimate as bidirectional', async () => {
    const forward = await api.request(
      '/transport/travel-estimates?fromStopCode=banani-road-11&toStopCode=gulshan-1',
    );
    const reverse = await api.request(
      '/transport/travel-estimates?fromStopCode=gulshan-1&toStopCode=banani-road-11',
    );

    assert.strictEqual(forward.status, 200);
    assert.strictEqual(reverse.status, 404);
    assert.match(reverse.body.error.message, /No travel estimate/);
  });

  it('returns 400 for missing, identical or unsupported parameters', async () => {
    const missing = await api.request('/transport/travel-estimates?fromStopCode=gulshan-1');
    assert.strictEqual(missing.status, 400);

    const identical = await api.request(
      '/transport/travel-estimates?fromStopCode=gulshan-1&toStopCode=gulshan-1',
    );
    assert.strictEqual(identical.status, 400);

    const unsupported = await api.request(
      '/transport/travel-estimates?fromStopCode=gulshan-1&toStopCode=mohakhali-wireless-gate&x=1',
    );
    assert.strictEqual(unsupported.status, 400);
  });

  it('rejects unknown and inactive stops', async () => {
    const unknown = await api.request(
      '/transport/travel-estimates?fromStopCode=no-such-stop&toStopCode=gulshan-1',
    );
    assert.strictEqual(unknown.status, 404);

    const inactive = await api.request(
      `/transport/travel-estimates?fromStopCode=${INACTIVE_STOP_CODE}&toStopCode=gulshan-1`,
    );
    assert.strictEqual(inactive.status, 409);
  });

  it('returns 404 when no estimate exists for a valid pair', async () => {
    const { status, body } = await api.request(
      '/transport/travel-estimates?fromStopCode=gulshan-1&toStopCode=banani-kakoli',
    );

    assert.strictEqual(status, 404);
    assert.match(body.error.message, /banani-kakoli/);
  });
});

/**
 * Declared last on purpose: the workspace must not contain a reverse corridor
 * while the "one-way" tests above run. The corridor is created committed (the
 * API cannot see uncommitted work) and removed again in `after`.
 */
describe('reverse direction once a reverse corridor exists', () => {
  const REVERSE_CORRIDOR = 'test-southbound-demo';

  before(async () => {
    await pool.query(`DELETE FROM corridors WHERE code = $1`, [REVERSE_CORRIDOR]);

    const { rows } = await pool.query(
      `INSERT INTO corridors (code, name, active) VALUES ($1, $2, true) RETURNING id`,
      [REVERSE_CORRIDOR, 'Test reverse demo corridor'],
    );
    const corridorId = rows[0].id;

    const reversed = [...EXPECTED_CORRIDOR_ORDER].reverse();
    for (const [index, stopCode] of reversed.entries()) {
      await pool.query(
        `INSERT INTO corridor_stops (corridor_id, stop_id, position)
         SELECT $1, id, $3 FROM stops WHERE code = $2`,
        [corridorId, stopCode, index + 1],
      );
    }
  });

  after(async () => {
    // corridor_stops rows are removed by ON DELETE CASCADE.
    await pool.query(`DELETE FROM corridors WHERE code = $1`, [REVERSE_CORRIDOR]);
  });

  it('matches the reversed journey only against the reverse corridor', async () => {
    const { status, body } = await api.request(
      '/transport/corridors/match?pickupStopCode=mohakhali-bus-terminal&dropoffStopCode=banani-road-11',
    );

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      body.data.map((match) => match.corridor.code),
      [REVERSE_CORRIDOR],
    );
    assert.ok(!body.data.some((match) => match.corridor.code === NORTHBOUND_CORRIDOR));
  });

  it('keeps every seeded stop code available', async () => {
    const { body } = await api.request('/transport/stops');

    assert.deepStrictEqual(body.data.map((stop) => stop.code).sort(), ALL_STOP_CODES);
  });
});
