import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { LOCATION_ZONES } from '../../src/db/seeds/location.data.js';
import { vertexCode } from '../../src/db/seeds/location.seed.js';
import { closePool, pool, prepareDatabase, runSeed } from '../helpers/db.js';

/**
 * Seed behaviour: the totals the brief requires, that every point lands in the
 * zone it belongs to, that repeated runs change nothing, and that the seeder
 * never removes data it did not create.
 */

const counts = async () => {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM service_zones)  AS zones,
            (SELECT count(*)::int FROM service_points) AS points,
            (SELECT count(*)::int FROM routing_vertices) AS vertices,
            (SELECT count(*)::int FROM routing_edges) AS edges`,
  );
  return rows[0];
};

before(async () => {
  await prepareDatabase();
});

after(async () => {
  await closePool();
});

describe('location seed totals', () => {
  it('creates at least 15 zones and at least 45 service points', async () => {
    const { zones, points, vertices } = await counts();

    assert.ok(zones >= 15, `expected >= 15 zones, got ${zones}`);
    assert.ok(points >= 45, `expected >= 45 service points, got ${points}`);
    assert.strictEqual(vertices, points, 'every service point gets exactly one routing vertex');
  });

  it('reports the totals it wrote', async () => {
    const summary = await runSeed();
    const stored = await counts();

    assert.strictEqual(summary.zones, stored.zones);
    assert.strictEqual(summary.points, stored.points);
    assert.strictEqual(summary.vertices, stored.vertices);
    assert.strictEqual(summary.edges, stored.edges);
  });

  it('gives every zone at least three active points', async () => {
    const { rows } = await pool.query(
      `SELECT z.code, count(p.id)::int AS active_points
         FROM service_zones z
         LEFT JOIN service_points p ON p.zone_id = z.id AND p.active
        GROUP BY z.id, z.code
       HAVING count(p.id) < 3`,
    );

    assert.deepStrictEqual(rows, [], 'every seeded zone should have at least three active points');
  });
});

describe('location seed content', () => {
  it('places every seeded point in the zone it belongs to', async () => {
    for (const zone of LOCATION_ZONES) {
      const { rows } = await pool.query(
        `SELECT p.code FROM service_points p JOIN service_zones z ON z.id = p.zone_id
          WHERE z.code = $1 ORDER BY p.code`,
        [zone.code],
      );

      assert.deepStrictEqual(
        rows.map((row) => row.code),
        zone.points.map((point) => point.code).sort(),
        `zone "${zone.code}" does not contain the points the seed data declares`,
      );
    }
  });

  it('stores unique zone names and globally unique point codes', async () => {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM (SELECT name FROM service_zones GROUP BY name HAVING count(*) > 1) d) AS duplicate_zone_names,
         (SELECT count(*)::int FROM (SELECT code FROM service_points GROUP BY code HAVING count(*) > 1) d) AS duplicate_point_codes,
         (SELECT count(DISTINCT code)::int FROM service_points) AS distinct_point_codes,
         (SELECT count(*)::int FROM service_points) AS point_count`,
    );

    assert.strictEqual(rows[0].duplicate_zone_names, 0);
    assert.strictEqual(rows[0].duplicate_point_codes, 0);
    assert.strictEqual(rows[0].distinct_point_codes, rows[0].point_count);
  });

  it('connects each point to the routing vertex derived from its code', async () => {
    const { rows } = await pool.query(
      `SELECT p.code AS point_code, v.code AS vertex_code
         FROM service_points p JOIN routing_vertices v ON v.id = p.routing_vertex_id`,
    );

    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.strictEqual(row.vertex_code, vertexCode(row.point_code));
    }
  });

  it('derives each zone centre from its own points', async () => {
    for (const zone of LOCATION_ZONES) {
      const expectedLatitude =
        zone.points.reduce((sum, point) => sum + point.latitude, 0) / zone.points.length;
      const expectedLongitude =
        zone.points.reduce((sum, point) => sum + point.longitude, 0) / zone.points.length;

      const { rows } = await pool.query(
        `SELECT ST_Y(center_location::geometry)::float AS latitude,
                ST_X(center_location::geometry)::float AS longitude
           FROM service_zones WHERE code = $1`,
        [zone.code],
      );

      assert.ok(
        Math.abs(rows[0].latitude - expectedLatitude) < 0.000_002,
        `zone "${zone.code}" centre latitude is not the mean of its points`,
      );
      assert.ok(
        Math.abs(rows[0].longitude - expectedLongitude) < 0.000_002,
        `zone "${zone.code}" centre longitude is not the mean of its points`,
      );
    }
  });

  it('keeps every point inside the Dhaka bounds and never repeats a coordinate in a zone', async () => {
    const { rows } = await pool.query(
      `SELECT z.code AS zone_code,
              ST_Y(p.location::geometry)::float AS latitude,
              ST_X(p.location::geometry)::float AS longitude
         FROM service_points p JOIN service_zones z ON z.id = p.zone_id`,
    );

    for (const row of rows) {
      assert.ok(row.latitude >= 23.6 && row.latitude <= 23.95, `${row.latitude} is outside Dhaka`);
      assert.ok(row.longitude >= 90.3 && row.longitude <= 90.5, `${row.longitude} is outside Dhaka`);
    }

    const perZone = new Map();
    for (const row of rows) {
      const key = `${row.latitude},${row.longitude}`;
      const seen = perZone.get(row.zone_code) ?? new Set();
      assert.ok(!seen.has(key), `zone "${row.zone_code}" has two points at ${key}`);
      seen.add(key);
      perZone.set(row.zone_code, seen);
    }
  });
});

describe('location seed idempotency', () => {
  it('creates no duplicates when run repeatedly', async () => {
    await runSeed();
    const before = await counts();

    await runSeed();
    await runSeed();

    assert.deepStrictEqual(await counts(), before);
  });

  it('leaves a user-created zone, point and edge alone', async () => {
    const zoneCode = 'test-seed-user-zone';
    const pointCode = 'test-seed-user-point';
    const edgeCodeForUser = 'test-seed-user-edge';
    const userVertex = vertexCode(pointCode);

    const cleanup = async () => {
      await pool.query(`DELETE FROM routing_edges WHERE code = $1`, [edgeCodeForUser]);
      await pool.query(`DELETE FROM service_points WHERE code = $1`, [pointCode]);
      await pool.query(`DELETE FROM routing_vertices WHERE code = $1`, [userVertex]);
      await pool.query(`DELETE FROM service_zones WHERE code = $1`, [zoneCode]);
    };

    await cleanup();

    const { rows: zoneRows } = await pool.query(
      `INSERT INTO service_zones (code, name, center_location)
       VALUES ($1, 'Test Seed User Zone', ST_SetSRID(ST_MakePoint(90.4, 23.8), 4326)::geography)
       RETURNING id`,
      [zoneCode],
    );
    const { rows: vertexRows } = await pool.query(
      `INSERT INTO routing_vertices (code, location)
       VALUES ($1, ST_SetSRID(ST_MakePoint(90.4, 23.8), 4326)) RETURNING id`,
      [userVertex],
    );
    await pool.query(
      `INSERT INTO service_points (zone_id, routing_vertex_id, code, name, location)
       VALUES ($1, $2, $3, 'Test Seed User Point', ST_SetSRID(ST_MakePoint(90.4, 23.8), 4326)::geography)`,
      [zoneRows[0].id, vertexRows[0].id, pointCode],
    );

    // The seeder refuses to leave an active vertex isolated, so a user-created
    // vertex has to be wired into the network before the seed will run at all --
    // which is itself part of the behaviour worth pinning down.
    await pool.query(
      `INSERT INTO routing_edges (
         code, source_vertex_id, target_vertex_id, geometry, distance_meters,
         normal_duration_seconds, rush_hour_duration_seconds,
         bidirectional, reverse_normal_duration_seconds, reverse_rush_hour_duration_seconds
       )
       SELECT $1, seeded.id, user_v.id, ST_MakeLine(seeded.location, user_v.location),
              ST_Length(ST_MakeLine(seeded.location, user_v.location)::geography),
              60, 90, true, 60, 90
         FROM routing_vertices seeded, routing_vertices user_v
        WHERE seeded.code = $2 AND user_v.code = $3`,
      [edgeCodeForUser, vertexCode('banani-road-11'), userVertex],
    );

    try {
      await runSeed();

      const { rows } = await pool.query(
        `SELECT (SELECT count(*)::int FROM service_zones WHERE code = $1) AS zones,
                (SELECT count(*)::int FROM service_points WHERE code = $2) AS points,
                (SELECT count(*)::int FROM routing_edges WHERE code = $3) AS edges`,
        [zoneCode, pointCode, edgeCodeForUser],
      );

      assert.strictEqual(rows[0].zones, 1, 'the seeder must not delete a user-created zone');
      assert.strictEqual(rows[0].points, 1, 'the seeder must not delete a user-created point');
      assert.strictEqual(rows[0].edges, 1, 'the seeder must not delete a user-created edge');
    } finally {
      await cleanup();
    }
  });
});
