import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { EDGE_ENDPOINT_TOLERANCE_METERS } from '../../src/db/seeds/location.seed.js';
import { closePool, pool, prepareDatabase, runSeed } from '../helpers/db.js';

/**
 * The stored routing graph.
 *
 * These tests assert that the graph is *valid and connected* -- every point has
 * a vertex, every vertex has an edge, one weakly connected component, geometry
 * that belongs to its endpoints. They deliberately do NOT run a pathfinding
 * algorithm: routing, quotes and fares are a later phase, and a recursive CTE
 * used here is a connectivity check, not a route.
 */

const graphCounts = async () => {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM routing_vertices) AS vertices,
            (SELECT count(*)::int FROM routing_edges) AS edges,
            (SELECT count(*)::int FROM routing_edges WHERE bidirectional) AS bidirectional,
            (SELECT count(*)::int FROM routing_edges WHERE NOT bidirectional) AS one_way`,
  );
  return rows[0];
};

before(async () => {
  await prepareDatabase();
});

after(async () => {
  await closePool();
});

describe('routing graph shape', () => {
  it('gives every service point exactly one routing vertex', async () => {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM service_points) AS points,
         (SELECT count(*)::int FROM service_points WHERE routing_vertex_id IS NULL) AS without_vertex,
         (SELECT count(DISTINCT routing_vertex_id)::int FROM service_points) AS distinct_vertices`,
    );

    assert.strictEqual(rows[0].without_vertex, 0, 'every service point must reference a vertex');
    assert.strictEqual(rows[0].distinct_vertices, rows[0].points, 'one vertex per point in this seed');
  });

  it('gives every active vertex at least one active edge', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS isolated
         FROM routing_vertices v
        WHERE v.active AND NOT EXISTS (
          SELECT 1 FROM routing_edges e
           WHERE e.active AND (e.source_vertex_id = v.id OR e.target_vertex_id = v.id)
        )`,
    );

    assert.strictEqual(rows[0].isolated, 0);
  });

  it('connects every zone to at least one other zone', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS stranded
         FROM service_zones z
        WHERE z.active AND NOT EXISTS (
          SELECT 1
            FROM service_points p
            JOIN routing_edges e
              ON e.active
             AND (e.source_vertex_id = p.routing_vertex_id OR e.target_vertex_id = p.routing_vertex_id)
            JOIN service_points other
              ON other.routing_vertex_id = CASE
                   WHEN e.source_vertex_id = p.routing_vertex_id THEN e.target_vertex_id
                   ELSE e.source_vertex_id
                 END
           WHERE p.zone_id = z.id AND other.zone_id <> z.id
        )`,
    );

    assert.strictEqual(rows[0].stranded, 0);
  });

  it('is a single weakly connected component', async () => {
    const { rows } = await pool.query(
      `WITH RECURSIVE undirected AS (
         SELECT source_vertex_id AS a, target_vertex_id AS b FROM routing_edges WHERE active
         UNION ALL
         SELECT target_vertex_id, source_vertex_id FROM routing_edges WHERE active
       ),
       walk AS (
         (SELECT id AS node FROM routing_vertices WHERE active ORDER BY code LIMIT 1)
         UNION
         SELECT u.b FROM walk w JOIN undirected u ON u.a = w.node
       )
       SELECT (SELECT count(*)::int FROM walk) AS reached,
              (SELECT count(*)::int FROM routing_vertices WHERE active) AS total`,
    );

    assert.ok(rows[0].total > 0);
    assert.strictEqual(
      rows[0].reached,
      rows[0].total,
      'every seeded vertex must be reachable from any other',
    );
  });

  it('mixes one-way and bidirectional edges', async () => {
    const { edges, bidirectional, one_way: oneWay } = await graphCounts();

    assert.strictEqual(bidirectional + oneWay, edges);
    assert.ok(oneWay > 0, 'the seed should demonstrate at least one one-way edge');
    assert.ok(bidirectional > oneWay, 'most edges should be two-way');
  });
});

describe('routing edge integrity', () => {
  it('has no self-loop and no edge missing a vertex', async () => {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM routing_edges WHERE source_vertex_id = target_vertex_id) AS self_loops,
         (SELECT count(*)::int FROM routing_edges e
           LEFT JOIN routing_vertices s ON s.id = e.source_vertex_id
           LEFT JOIN routing_vertices t ON t.id = e.target_vertex_id
          WHERE s.id IS NULL OR t.id IS NULL) AS missing_vertex`,
    );

    assert.strictEqual(rows[0].self_loops, 0);
    assert.strictEqual(rows[0].missing_vertex, 0);
  });

  it('has valid LineString geometry with at least two points', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS malformed FROM routing_edges
        WHERE NOT ST_IsValid(geometry) OR ST_NPoints(geometry) < 2 OR geometry IS NULL`,
    );

    assert.strictEqual(rows[0].malformed, 0);
  });

  it('stores a distance that matches ST_Length within tolerance', async () => {
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE abs(distance_meters - ST_Length(geometry::geography)) > 0.01)::int AS mismatched,
              coalesce(max(abs(distance_meters - ST_Length(geometry::geography))), 0)::float AS worst
         FROM routing_edges`,
    );

    assert.strictEqual(rows[0].mismatched, 0);
    // The column is NUMERIC(12,2), so rounding alone can differ by half a centimetre.
    assert.ok(rows[0].worst <= 0.01, `worst distance disagreement was ${rows[0].worst} m`);
  });

  it('starts each edge near its source vertex and ends it near its target', async () => {
    const { rows } = await pool.query(
      `SELECT coalesce(max(GREATEST(
                ST_Distance(ST_StartPoint(e.geometry)::geography, s.location::geography),
                ST_Distance(ST_EndPoint(e.geometry)::geography, t.location::geography)
              )), 0)::float AS worst_offset
         FROM routing_edges e
         JOIN routing_vertices s ON s.id = e.source_vertex_id
         JOIN routing_vertices t ON t.id = e.target_vertex_id`,
    );

    assert.ok(
      rows[0].worst_offset <= EDGE_ENDPOINT_TOLERANCE_METERS,
      `an edge endpoint is ${rows[0].worst_offset}m from its vertex`,
    );
  });

  it('keeps duration, direction and fare-weight invariants', async () => {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM routing_edges WHERE normal_duration_seconds <= 0) AS bad_normal,
         (SELECT count(*)::int FROM routing_edges WHERE rush_hour_duration_seconds <= 0) AS bad_rush,
         (SELECT count(*)::int FROM routing_edges WHERE rush_hour_duration_seconds < normal_duration_seconds) AS rush_faster,
         (SELECT count(*)::int FROM routing_edges WHERE fare_weight <= 0) AS bad_weight,
         (SELECT count(*)::int FROM routing_edges WHERE distance_meters <= 0) AS bad_distance,
         (SELECT count(*)::int FROM routing_edges
           WHERE bidirectional AND (reverse_normal_duration_seconds IS NULL
                                 OR reverse_rush_hour_duration_seconds IS NULL)) AS two_way_without_reverse,
         (SELECT count(*)::int FROM routing_edges
           WHERE NOT bidirectional AND (reverse_normal_duration_seconds IS NOT NULL
                                     OR reverse_rush_hour_duration_seconds IS NOT NULL)) AS one_way_with_reverse`,
    );

    assert.deepStrictEqual(rows[0], {
      bad_normal: 0,
      bad_rush: 0,
      rush_faster: 0,
      bad_weight: 0,
      bad_distance: 0,
      two_way_without_reverse: 0,
      one_way_with_reverse: 0,
    });
  });

  it('uses a stable, unique code per edge', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS edges, count(DISTINCT code)::int AS distinct_codes FROM routing_edges`,
    );

    assert.strictEqual(rows[0].distinct_codes, rows[0].edges);
  });
});

describe('routing graph seed idempotency', () => {
  it('creates no duplicate vertices or edges when run repeatedly', async () => {
    await runSeed();
    const before = await graphCounts();

    await runSeed();
    await runSeed();

    assert.deepStrictEqual(await graphCounts(), before);

    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM routing_vertices) - (SELECT count(DISTINCT code)::int FROM routing_vertices) AS duplicate_vertices,
         (SELECT count(*)::int FROM routing_edges) - (SELECT count(DISTINCT code)::int FROM routing_edges) AS duplicate_edges`,
    );

    assert.strictEqual(rows[0].duplicate_vertices, 0);
    assert.strictEqual(rows[0].duplicate_edges, 0);
  });
});
