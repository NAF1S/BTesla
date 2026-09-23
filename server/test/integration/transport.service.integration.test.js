import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import * as transport from '../../src/services/transport.service.js';
import { closePool, pool, prepareDatabase } from '../helpers/db.js';

/**
 * Service-layer tests: these call the SQL directly, so a passing HTTP test can
 * never hide a query that happens to agree with a buggy expectation.
 */

const NORTHBOUND_CORRIDOR = 'northbound-demo';
const EXPECTED_CORRIDOR_ORDER = [
  'banani-road-11',
  'banani-kakoli',
  'banani-chairman-bari',
  'gulshan-1',
  'mohakhali-wireless-gate',
  'mohakhali-bus-terminal',
];

const INACTIVE_STOP_CODE = 'test-service-inactive-stop';

const stopIdByCode = async (code) => {
  const { rows } = await pool.query(`SELECT id FROM stops WHERE code = $1`, [code]);
  assert.ok(rows[0], `expected the seeded stop ${code} to exist`);
  return rows[0].id;
};

before(async () => {
  await prepareDatabase();
  await pool.query(`DELETE FROM stops WHERE code = $1`, [INACTIVE_STOP_CODE]);
  await pool.query(
    `INSERT INTO stops (zone_id, code, name, active)
     SELECT id, $1, 'Test inactive service stop', false FROM zones WHERE code = 'banani'`,
    [INACTIVE_STOP_CODE],
  );
});

after(async () => {
  await pool.query(`DELETE FROM stops WHERE code = $1`, [INACTIVE_STOP_CODE]);
  await closePool();
});

describe('transport.service stops', () => {
  it('lists active zones only', async () => {
    const zones = await transport.findActiveZones();

    assert.deepStrictEqual(
      zones.map((zone) => zone.code),
      ['banani', 'gulshan', 'mohakhali'],
    );
  });

  it('filters active stops by zone code and excludes inactive stops', async () => {
    const all = await transport.findActiveStops();
    assert.deepStrictEqual(all.map((stop) => stop.code).sort(), [...EXPECTED_CORRIDOR_ORDER].sort());
    assert.ok(!all.some((stop) => stop.code === INACTIVE_STOP_CODE));

    const banani = await transport.findActiveStops({ zoneCode: 'banani' });
    assert.deepStrictEqual(
      banani.map((stop) => stop.code),
      ['banani-chairman-bari', 'banani-kakoli', 'banani-road-11'],
    );
    assert.ok(banani.every((stop) => stop.zone_code === 'banani'));

    const mohakhali = await transport.findActiveStops({ zoneCode: 'mohakhali' });
    assert.deepStrictEqual(
      mohakhali.map((stop) => stop.code),
      ['mohakhali-bus-terminal', 'mohakhali-wireless-gate'],
    );

    const unknownZone = await transport.findActiveStops({ zoneCode: 'nowhere' });
    assert.deepStrictEqual(unknownZone, []);
  });

  it('returns null for an unknown stop and the row for an inactive one', async () => {
    assert.strictEqual(await transport.findStopByCode('no-such-stop'), null);

    const inactive = await transport.findStopByCode(INACTIVE_STOP_CODE);
    assert.ok(inactive, 'the row must be returned so the API can answer 409');
    assert.strictEqual(inactive.active, false);
  });

  it('returns the zone of a stop by code regardless of case handling elsewhere', async () => {
    const stop = await transport.findStopByCode('banani-road-11');

    assert.strictEqual(stop.zone_code, 'banani');
    assert.strictEqual(stop.name, 'Banani Road 11');
  });
});

describe('transport.service corridors', () => {
  it('lists active corridors', async () => {
    const corridors = await transport.findActiveCorridors();

    assert.ok(corridors.some((corridor) => corridor.code === NORTHBOUND_CORRIDOR));
    assert.ok(corridors.every((corridor) => corridor.active === true));
  });

  it('returns corridor stops ordered by position', async () => {
    const corridor = await transport.findCorridorByCode(NORTHBOUND_CORRIDOR);
    const stops = await transport.findCorridorStops(corridor.id);

    assert.deepStrictEqual(
      stops.map((stop) => stop.code),
      EXPECTED_CORRIDOR_ORDER,
    );
    assert.deepStrictEqual(
      stops.map((stop) => Number(stop.position)),
      [1, 2, 3, 4, 5, 6],
    );
  });

  it('finds the corridor for a pickup before a drop-off', async () => {
    const pickup = await stopIdByCode('banani-road-11');
    const dropoff = await stopIdByCode('mohakhali-bus-terminal');

    const matches = await transport.findCorridorsForStopPair(pickup, dropoff);

    assert.deepStrictEqual(
      matches.map((match) => [match.code, Number(match.pickup_position), Number(match.dropoff_position)]),
      [[NORTHBOUND_CORRIDOR, 1, 6]],
    );
  });

  it('does not match the same pair in the reverse direction', async () => {
    const pickup = await stopIdByCode('mohakhali-bus-terminal');
    const dropoff = await stopIdByCode('banani-road-11');

    const matches = await transport.findCorridorsForStopPair(pickup, dropoff);

    assert.ok(
      !matches.some((match) => match.code === NORTHBOUND_CORRIDOR),
      'a one-way corridor must not match its own stops in reverse order',
    );
  });
});

describe('transport.service travel estimates', () => {
  it('returns the direct directional estimate', async () => {
    const from = await stopIdByCode('banani-kakoli');
    const to = await stopIdByCode('mohakhali-wireless-gate');

    const estimate = await transport.findTravelEstimate(from, to);

    assert.strictEqual(estimate.from_stop_code, 'banani-kakoli');
    assert.strictEqual(estimate.to_stop_code, 'mohakhali-wireless-gate');
    assert.strictEqual(Number(estimate.estimated_minutes), 24);
    assert.strictEqual(Number(estimate.estimated_distance_km), 7.1);
    assert.strictEqual(Number(estimate.base_fare), 215);
    assert.strictEqual(estimate.currency, 'BDT');
  });

  it('never falls back to the reverse estimate', async () => {
    const roadEleven = await stopIdByCode('banani-road-11');
    const gulshanOne = await stopIdByCode('gulshan-1');

    const forward = await transport.findTravelEstimate(roadEleven, gulshanOne);
    const reverse = await transport.findTravelEstimate(gulshanOne, roadEleven);

    assert.ok(forward, 'Banani Road 11 -> Gulshan 1 is seeded');
    assert.strictEqual(reverse, null, 'Gulshan 1 -> Banani Road 11 is not seeded');
  });

  it('returns null for a pair without an estimate', async () => {
    const from = await stopIdByCode('gulshan-1');
    const to = await stopIdByCode('banani-kakoli');

    assert.strictEqual(await transport.findTravelEstimate(from, to), null);
  });
});
