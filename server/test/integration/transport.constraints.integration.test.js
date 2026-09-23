import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { closePool, expectPgError, withRollback } from '../helpers/db.js';

/**
 * Database-level guarantees of the transport schema. Every case runs inside a
 * transaction that is rolled back, so no test data is ever committed.
 *
 * SQLSTATE codes: 23505 unique_violation, 23503 foreign_key_violation,
 * 23514 check_violation. These tests pin down the schema itself; how the API
 * turns those violations into 400/404/409 responses is covered by the API and
 * unit tests. `expectPgError` uses a savepoint so several violations can be
 * asserted inside one transaction.
 */

const createStop = async (client, code, zoneCode = 'banani') => {
  const { rows } = await client.query(
    `INSERT INTO stops (zone_id, code, name)
     SELECT id, $1, $1 FROM zones WHERE code = $2
     RETURNING id`,
    [code, zoneCode],
  );
  return rows[0].id;
};

const createCorridor = async (client, code) => {
  const { rows } = await client.query(
    `INSERT INTO corridors (code, name) VALUES ($1, $1) RETURNING id`,
    [code],
  );
  return rows[0].id;
};

const addCorridorStop = (client, corridorId, stopId, position) =>
  client.query(
    `INSERT INTO corridor_stops (corridor_id, stop_id, position) VALUES ($1, $2, $3)`,
    [corridorId, stopId, position],
  );

const addEstimate = (client, fromStopId, toStopId, minutes, distanceKm, baseFare) =>
  client.query(
    `INSERT INTO travel_estimates
       (from_stop_id, to_stop_id, estimated_minutes, estimated_distance_km, base_fare)
     VALUES ($1, $2, $3, $4, $5)`,
    [fromStopId, toStopId, minutes, distanceKm, baseFare],
  );

after(async () => {
  await closePool();
});

describe('corridor_stops constraints', () => {
  it('prevents two stops from sharing a position in the same corridor', async () => {
    await withRollback(async (client) => {
      const corridorId = await createCorridor(client, 'test-constraint-positions');
      const stopA = await createStop(client, 'test-constraint-position-stop-a');
      const stopB = await createStop(client, 'test-constraint-position-stop-b');

      await addCorridorStop(client, corridorId, stopA, 1);
      await expectPgError(client, () => addCorridorStop(client, corridorId, stopB, 1), '23505');
    });
  });

  it('allows the same position in a different corridor', async () => {
    await withRollback(async (client) => {
      const corridorA = await createCorridor(client, 'test-constraint-corridor-a');
      const corridorB = await createCorridor(client, 'test-constraint-corridor-b');
      const stop = await createStop(client, 'test-constraint-shared-stop');

      await addCorridorStop(client, corridorA, stop, 1);
      await addCorridorStop(client, corridorB, stop, 1);
    });
  });

  it('prevents a stop from appearing twice in the same corridor', async () => {
    await withRollback(async (client) => {
      const corridorId = await createCorridor(client, 'test-constraint-duplicate-stop');
      const stop = await createStop(client, 'test-constraint-repeated-stop');

      await addCorridorStop(client, corridorId, stop, 1);
      await expectPgError(client, () => addCorridorStop(client, corridorId, stop, 2), '23505');
    });
  });

  it('requires a positive position and known references', async () => {
    await withRollback(async (client) => {
      const corridorId = await createCorridor(client, 'test-constraint-position-sign');
      const stop = await createStop(client, 'test-constraint-position-sign-stop');

      await expectPgError(client, () => addCorridorStop(client, corridorId, stop, 0), '23514');
      await expectPgError(client, () => addCorridorStop(client, corridorId, stop, -1), '23514');
      await expectPgError(
        client,
        () => addCorridorStop(client, corridorId, '00000000-0000-0000-0000-000000000000', 1),
        '23503',
      );
    });
  });
});

describe('travel_estimates constraints', () => {
  it('rejects an estimate whose origin and destination are the same stop', async () => {
    await withRollback(async (client) => {
      const stop = await createStop(client, 'test-constraint-same-stop');

      await expectPgError(client, () => addEstimate(client, stop, stop, 10, 2.5, 50), '23514');
    });
  });

  it('treats A -> B and B -> A as two separate records', async () => {
    await withRollback(async (client) => {
      const stopA = await createStop(client, 'test-constraint-dir-stop-a');
      const stopB = await createStop(client, 'test-constraint-dir-stop-b');

      await addEstimate(client, stopA, stopB, 10, 2.5, 50);
      // The reverse direction is a different row and must be insertable.
      await addEstimate(client, stopB, stopA, 12, 3.1, 60);

      // ...but the same direction twice is not.
      await expectPgError(client, () => addEstimate(client, stopA, stopB, 99, 9.9, 990), '23505');
    });
  });

  it('requires positive minutes and distance, and a non-negative fare', async () => {
    await withRollback(async (client) => {
      const stopA = await createStop(client, 'test-constraint-value-stop-a');
      const stopB = await createStop(client, 'test-constraint-value-stop-b');

      await expectPgError(client, () => addEstimate(client, stopA, stopB, 0, 2.5, 50), '23514');
      await expectPgError(client, () => addEstimate(client, stopA, stopB, -5, 2.5, 50), '23514');
      await expectPgError(client, () => addEstimate(client, stopA, stopB, 10, 0, 50), '23514');
      await expectPgError(client, () => addEstimate(client, stopA, stopB, 10, 2.5, -1), '23514');

      // A free trip is allowed: the fare may be zero.
      await addEstimate(client, stopA, stopB, 10, 2.5, 0);
    });
  });

  it('requires existing stops and a well-formed currency', async () => {
    await withRollback(async (client) => {
      const stop = await createStop(client, 'test-constraint-currency-stop');

      await expectPgError(
        client,
        () => addEstimate(client, stop, '00000000-0000-0000-0000-000000000000', 10, 2.5, 50),
        '23503',
      );

      await expectPgError(
        client,
        () =>
          client.query(
            `INSERT INTO travel_estimates
               (from_stop_id, to_stop_id, estimated_minutes, estimated_distance_km, base_fare, currency)
             VALUES ($1, $1, 10, 2.5, 50, 'taka')`,
            [stop],
          ),
        '23514',
      );
    });
  });
});

describe('stops and zones constraints', () => {
  it('requires a unique, well-formed stop code and a known zone', async () => {
    await withRollback(async (client) => {
      const stop = await createStop(client, 'test-constraint-unique-stop');
      assert.ok(stop);

      await expectPgError(client, () => createStop(client, 'test-constraint-unique-stop'), '23505');

      await expectPgError(
        client,
        () =>
          client.query(`INSERT INTO stops (zone_id, code, name) VALUES ($1, $2, $2)`, [
            '00000000-0000-0000-0000-000000000000',
            'test-constraint-orphan-stop',
          ]),
        '23503',
      );

      await expectPgError(
        client,
        () =>
          client.query(
            `INSERT INTO stops (zone_id, code, name)
             SELECT id, 'Not A Code', 'Bad' FROM zones WHERE code = 'banani'`,
          ),
        '23514',
      );
    });
  });

  it('allows stops without coordinates but rejects out-of-range ones', async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO stops (zone_id, code, name)
         SELECT id, 'test-constraint-no-coordinates', 'No coordinates' FROM zones WHERE code = 'banani'
         RETURNING latitude, longitude`,
      );
      assert.strictEqual(rows[0].latitude, null);
      assert.strictEqual(rows[0].longitude, null);

      await expectPgError(
        client,
        () =>
          client.query(
            `INSERT INTO stops (zone_id, code, name, latitude)
             SELECT id, 'test-constraint-bad-latitude', 'Bad latitude', 123.456 FROM zones WHERE code = 'banani'`,
          ),
        '23514',
      );
    });
  });

  it('stores money and distances as exact NUMERIC values', async () => {
    await withRollback(async (client) => {
      const stopA = await createStop(client, 'test-constraint-numeric-stop-a');
      const stopB = await createStop(client, 'test-constraint-numeric-stop-b');

      // pg_typeof() returns the internal `regtype` type, which Prisma cannot
      // deserialize, so both readings are cast to text. That also proves the
      // value round-trips exactly (99.99, not 99.98999999999999).
      const { rows } = await client.query(
        `INSERT INTO travel_estimates
           (from_stop_id, to_stop_id, estimated_minutes, estimated_distance_km, base_fare, currency)
         VALUES ($1, $2, 7, 12.35, 99.99, 'BDT')
         RETURNING pg_typeof(base_fare)::text AS fare_type, base_fare::text AS base_fare, currency`,
        [stopA, stopB],
      );

      assert.strictEqual(rows[0].fare_type, 'numeric');
      assert.strictEqual(rows[0].base_fare, '99.99');
      assert.strictEqual(rows[0].currency, 'BDT');
    });
  });
});
