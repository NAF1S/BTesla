import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { closePool, pool, prepareDatabase, runSeed, scalarCount, withRollback } from '../helpers/db.js';
import { seedCorridorStops } from '../../src/db/seeds/transport-network.data.js';
import { seedTransportNetwork } from '../../src/db/seeds/transport-network.seed.js';

/**
 * Proves the transport seed script is deterministic and idempotent, and that
 * it never removes data it does not own.
 */

const SEEDED_ZONE_CODES = ['banani', 'gulshan', 'mohakhali'];
const SEEDED_CORRIDOR_CODES = ['northbound-demo'];
const EXPECTED_CORRIDOR_ORDER = [
  'banani-road-11',
  'banani-kakoli',
  'banani-chairman-bari',
  'gulshan-1',
  'mohakhali-wireless-gate',
  'mohakhali-bus-terminal',
];

const EXPECTED_SUMMARY = {
  zones: 3,
  stops: 6,
  corridors: 1,
  corridorStops: 6,
  travelEstimates: 6,
};

/**
 * Rows this suite creates to stand in for user data. They are all inactive so
 * that a crash mid-suite can never influence the read endpoints asserted by
 * the other integration tests sharing this database.
 */
const USER_ZONE = 'test-user-zone';
const USER_STOPS = ['test-user-stop-a', 'test-user-stop-b'];
const USER_CORRIDOR = 'test-user-corridor';

const cleanupUserData = async () => {
  await pool.query(
    `DELETE FROM travel_estimates
      WHERE from_stop_id IN (SELECT id FROM stops WHERE code = ANY($1))
         OR to_stop_id IN (SELECT id FROM stops WHERE code = ANY($1))`,
    [USER_STOPS],
  );
  await pool.query(`DELETE FROM corridors WHERE code = $1`, [USER_CORRIDOR]);
  await pool.query(`DELETE FROM stops WHERE code = ANY($1)`, [USER_STOPS]);
  await pool.query(`DELETE FROM zones WHERE code = $1`, [USER_ZONE]);
};

const createUserData = async () => {
  const { rows: zones } = await pool.query(
    `INSERT INTO zones (code, name, active) VALUES ($1, 'Test user zone', false)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [USER_ZONE],
  );

  const stopIds = [];
  for (const code of USER_STOPS) {
    const { rows } = await pool.query(
      `INSERT INTO stops (zone_id, code, name, active) VALUES ($1, $2, $2, false)
       ON CONFLICT (code) DO UPDATE SET zone_id = EXCLUDED.zone_id RETURNING id`,
      [zones[0].id, code],
    );
    stopIds.push(rows[0].id);
  }

  const { rows: corridors } = await pool.query(
    `INSERT INTO corridors (code, name, active) VALUES ($1, 'Test user corridor', false)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [USER_CORRIDOR],
  );

  await pool.query(
    `INSERT INTO corridor_stops (corridor_id, stop_id, position) VALUES ($1, $2, 1)
     ON CONFLICT DO NOTHING`,
    [corridors[0].id, stopIds[0]],
  );
  await pool.query(
    `INSERT INTO travel_estimates (from_stop_id, to_stop_id, estimated_minutes, estimated_distance_km, base_fare)
     VALUES ($1, $2, 5, 1.1, 40) ON CONFLICT DO NOTHING`,
    [stopIds[0], stopIds[1]],
  );
};

/** Row counts restricted to seed-owned codes, so foreign rows never interfere. */
const seedRowCounts = async () => ({
  zones: await scalarCount(pool, `SELECT count(*) FROM zones WHERE code = ANY($1)`, [
    SEEDED_ZONE_CODES,
  ]),
  stops: await scalarCount(pool, `SELECT count(*) FROM stops WHERE code = ANY($1)`, [
    EXPECTED_CORRIDOR_ORDER,
  ]),
  corridors: await scalarCount(pool, `SELECT count(*) FROM corridors WHERE code = ANY($1)`, [
    SEEDED_CORRIDOR_CODES,
  ]),
  corridorStops: await scalarCount(
    pool,
    `SELECT count(*) FROM corridor_stops cs
       JOIN corridors c ON c.id = cs.corridor_id
      WHERE c.code = ANY($1)`,
    [SEEDED_CORRIDOR_CODES],
  ),
  travelEstimates: await scalarCount(
    pool,
    `SELECT count(*) FROM travel_estimates te
       JOIN stops origin ON origin.id = te.from_stop_id
       JOIN stops destination ON destination.id = te.to_stop_id
      WHERE origin.code = ANY($1) AND destination.code = ANY($1)`,
    [EXPECTED_CORRIDOR_ORDER],
  ),
});

const corridorOrder = async () => {
  const { rows } = await pool.query(
    `SELECT s.code, cs.position
       FROM corridor_stops cs
       JOIN corridors c ON c.id = cs.corridor_id
       JOIN stops s ON s.id = cs.stop_id
      WHERE c.code = 'northbound-demo'
      ORDER BY cs.position`,
  );
  return { codes: rows.map((row) => row.code), positions: rows.map((row) => Number(row.position)) };
};

before(async () => {
  await cleanupUserData();
  await prepareDatabase();
});

after(async () => {
  await cleanupUserData();
  await closePool();
});

describe('transport seed script', () => {
  it('seeds the demo network', async () => {
    const summary = await runSeed();

    assert.deepStrictEqual(summary, EXPECTED_SUMMARY);
    assert.deepStrictEqual(await seedRowCounts(), EXPECTED_SUMMARY);

    const { codes, positions } = await corridorOrder();
    assert.deepStrictEqual(codes, EXPECTED_CORRIDOR_ORDER);
    assert.deepStrictEqual(positions, [1, 2, 3, 4, 5, 6]);
  });

  it('is idempotent: running it again neither duplicates nor reorders anything', async () => {
    const before = await seedRowCounts();

    await runSeed();
    await runSeed();

    assert.deepStrictEqual(await seedRowCounts(), before);
    assert.deepStrictEqual(before, EXPECTED_SUMMARY);

    const duplicateCodes = await pool.query(
      `SELECT code, count(*) AS occurrences
         FROM stops GROUP BY code HAVING count(*) > 1`,
    );
    assert.strictEqual(duplicateCodes.rowCount, 0);

    const { codes, positions } = await corridorOrder();
    assert.deepStrictEqual(codes, EXPECTED_CORRIDOR_ORDER);
    assert.deepStrictEqual(positions, [1, 2, 3, 4, 5, 6]);
  });

  it('restores edited seed values instead of inserting new rows', async () => {
    await pool.query(`UPDATE zones SET name = 'Renamed by test' WHERE code = 'banani'`);
    await pool.query(`UPDATE stops SET latitude = 0 WHERE code = 'banani-road-11'`);

    await runSeed();

    const { rows } = await pool.query(
      `SELECT z.name AS zone_name, s.latitude
         FROM stops s JOIN zones z ON z.id = s.zone_id
        WHERE s.code = 'banani-road-11'`,
    );
    assert.strictEqual(rows[0].zone_name, 'Banani');
    assert.strictEqual(Number(rows[0].latitude), 23.7937);
    assert.strictEqual(await scalarCount(pool, `SELECT count(*) FROM zones`), 3);
  });

  it('leaves user-created data alone', async () => {
    try {
      await createUserData();
      await runSeed();

      const zone = await pool.query(`SELECT id, name FROM zones WHERE code = $1`, [USER_ZONE]);
      assert.strictEqual(zone.rowCount, 1);

      const stops = await pool.query(`SELECT code FROM stops WHERE code = ANY($1) ORDER BY code`, [
        USER_STOPS,
      ]);
      assert.deepStrictEqual(stops.rows.map((row) => row.code), [...USER_STOPS].sort());

      const corridorStops = await scalarCount(
        pool,
        `SELECT count(*) FROM corridor_stops cs
           JOIN corridors c ON c.id = cs.corridor_id
          WHERE c.code = $1`,
        [USER_CORRIDOR],
      );
      assert.strictEqual(corridorStops, 1);

      const estimates = await scalarCount(
        pool,
        `SELECT count(*) FROM travel_estimates te
           JOIN stops origin ON origin.id = te.from_stop_id
          WHERE origin.code = $1`,
        [USER_STOPS[0]],
      );
      assert.strictEqual(estimates, 1);
    } finally {
      await cleanupUserData();
    }
  });

  it('rewrites a reordered corridor stop list without breaking the position constraint', async () => {
    const seededOrder = seedCorridorStops['northbound-demo'];
    const original = [...seededOrder];
    const reversed = [...original].reverse();

    try {
      // Reversing the demo corridor means every position changes owner, which
      // is exactly the case the seeder's park-then-upsert rewrite must handle.
      // The seed runs in a transaction that is rolled back, so the committed
      // corridor order asserted by the other tests is untouched.
      seededOrder.splice(0, seededOrder.length, ...reversed);

      await withRollback(async (client) => {
        await seedTransportNetwork(client);

        const { rows } = await client.query(
          `SELECT s.code, cs.position
             FROM corridor_stops cs
             JOIN corridors c ON c.id = cs.corridor_id
             JOIN stops s ON s.id = cs.stop_id
            WHERE c.code = 'northbound-demo'
            ORDER BY cs.position`,
        );

        assert.deepStrictEqual(rows.map((row) => row.code), reversed);
        assert.deepStrictEqual(rows.map((row) => Number(row.position)), [1, 2, 3, 4, 5, 6]);
        assert.strictEqual(rows.length, original.length, 'no parked rows may survive a rewrite');
      });
    } finally {
      seededOrder.splice(0, seededOrder.length, ...original);
    }

    const { codes } = await corridorOrder();
    assert.deepStrictEqual(codes, EXPECTED_CORRIDOR_ORDER);
  });
});
