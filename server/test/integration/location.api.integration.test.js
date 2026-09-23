import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startApiServer } from '../helpers/api-server.js';
import { closePool, prepareDatabase } from '../helpers/db.js';

/**
 * End-to-end tests for the read-only location endpoints, driven through the real
 * Express app over HTTP.
 *
 * This suite also pins the phase boundary: it asserts that the superseded
 * transport endpoints are gone and that no routing, quote, fare or ride endpoint
 * has appeared.
 */

let api;

before(async () => {
  await prepareDatabase();
  api = await startApiServer();
});

after(async () => {
  await api?.close();
  await closePool();
});

describe('GET /api/location/zones', () => {
  it('lists at least 15 zones as DTOs with numeric coordinates', async () => {
    const { status, body } = await api.request('/location/zones');

    assert.strictEqual(status, 200);
    assert.ok(body.data.length >= 15, `expected >= 15 zones, got ${body.data.length}`);

    for (const zone of body.data) {
      assert.deepStrictEqual(Object.keys(zone).sort(), [
        'code',
        'id',
        'latitude',
        'longitude',
        'name',
      ]);
      assert.strictEqual(typeof zone.latitude, 'number');
      assert.strictEqual(typeof zone.longitude, 'number');
    }

    assert.ok(body.data.some((zone) => zone.code === 'banani'));
  });
});

describe('GET /api/location/points', () => {
  it('lists at least 45 active points without leaking internal columns', async () => {
    const { status, body } = await api.request('/location/points');

    assert.strictEqual(status, 200);
    assert.ok(body.data.length >= 45, `expected >= 45 points, got ${body.data.length}`);

    for (const point of body.data) {
      assert.deepStrictEqual(Object.keys(point).sort(), [
        'code',
        'id',
        'latitude',
        'longitude',
        'name',
        'zoneCode',
      ]);
    }
  });

  it('filters by zone code', async () => {
    const { status, body } = await api.request('/location/points?zoneCode=banani');

    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      body.data.map((point) => point.code).sort(),
      ['banani-chairman-bari', 'banani-kakoli', 'banani-road-11'],
    );
    assert.ok(body.data.every((point) => point.zoneCode === 'banani'));
  });

  it('normalises the zone code, so case does not matter', async () => {
    const { status, body } = await api.request('/location/points?zoneCode=BANANI');

    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.length, 3);
  });

  it('returns 404 for an unknown zone code', async () => {
    const { status, body } = await api.request('/location/points?zoneCode=nowhere');

    assert.strictEqual(status, 404);
    assert.match(body.error.message, /not found/i);
  });

  it('rejects a malformed or unsupported query', async () => {
    const malformed = await api.request('/location/points?zoneCode=not%20a%20code!');
    assert.strictEqual(malformed.status, 400);

    const unsupported = await api.request('/location/points?zoneId=banani');
    assert.strictEqual(unsupported.status, 400);
    assert.match(unsupported.body.error.message, /Unsupported query parameter/);
  });
});

describe('GET /api/location/points/:code', () => {
  it('returns one point by code', async () => {
    const { status, body } = await api.request('/location/points/banani-road-11');

    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.code, 'banani-road-11');
    assert.strictEqual(body.data.name, 'Banani Road 11');
    assert.strictEqual(body.data.zoneCode, 'banani');
    assert.strictEqual(body.data.latitude, 23.7937);
    assert.strictEqual(body.data.longitude, 90.4043);
  });

  it('returns 404 for an unknown code and 400 for a malformed one', async () => {
    const missing = await api.request('/location/points/no-such-point');
    assert.strictEqual(missing.status, 404);

    const malformed = await api.request('/location/points/not%20a%20code!');
    assert.strictEqual(malformed.status, 400);
  });
});

describe('phase boundary', () => {
  it('exposes no routing, quote, distance, fare, ride or matching endpoint', async () => {
    const paths = [
      '/location/route',
      '/location/routes',
      '/location/shortest-path',
      '/location/quote',
      '/location/distance',
      '/location/eta',
      '/location/fare',
      '/rides',
      '/ride-requests',
      '/pools',
      '/matches',
    ];

    for (const path of paths) {
      const { status } = await api.request(path);
      assert.strictEqual(status, 404, `${path} must not exist in this phase`);
    }
  });

  it('no longer exposes the superseded transport endpoints', async () => {
    const removed = [
      '/transport/zones',
      '/transport/stops',
      '/transport/stops/banani-road-11',
      '/transport/corridors',
      '/transport/corridors/match',
      '/transport/travel-estimates',
    ];

    for (const path of removed) {
      const { status } = await api.request(path);
      assert.strictEqual(status, 404, `${path} should have been removed with the old implementation`);
    }
  });
});
