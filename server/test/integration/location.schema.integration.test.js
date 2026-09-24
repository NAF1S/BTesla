import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { closePool, expectPgError, pool, prepareDatabase, withRollback } from '../helpers/db.js';

/**
 * PostGIS storage guarantees: the extension, the actual spatial column types,
 * the spatial indexes, that coordinates really are longitude/latitude, and that
 * proximity queries answer in metres.
 *
 * Requirements: `npm run db:up` with the PostGIS image from docker-compose.yml.
 */

const BANANI_ROAD_11 = { latitude: 23.7937, longitude: 90.4043 };

/** True when `table` has an index of `method` whose definition mentions `column`. */
const hasIndex = async (table, method, column) => {
  const { rows } = await pool.query(
    `SELECT am.amname AS method, pg_get_indexdef(x.indexrelid) AS definition
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_am am ON am.oid = i.relam
      WHERE c.relname = $1`,
    [table],
  );

  return rows.some((row) => row.method === method && row.definition.includes(column));
};

const geographyColumn = async (table, column) => {
  const { rows } = await pool.query(
    `SELECT type, srid FROM geography_columns
      WHERE f_table_name = $1 AND f_geography_column = $2`,
    [table, column],
  );
  return rows[0] ?? null;
};

const geometryColumn = async (table, column) => {
  const { rows } = await pool.query(
    `SELECT type, srid FROM geometry_columns
      WHERE f_table_name = $1 AND f_geometry_column = $2`,
    [table, column],
  );
  return rows[0] ?? null;
};

const createZone = async (client, code) => {
  const { rows } = await client.query(
    `INSERT INTO service_zones (code, name, center_location)
     VALUES ($1, $1, ST_SetSRID(ST_MakePoint(90.4, 23.8), 4326)::geography)
     RETURNING id`,
    [code],
  );
  return rows[0].id;
};

const createVertex = async (client, code) => {
  const { rows } = await client.query(
    `INSERT INTO routing_vertices (code, location)
     VALUES ($1, ST_SetSRID(ST_MakePoint(90.4, 23.8), 4326))
     RETURNING id`,
    [code],
  );
  return rows[0].id;
};

/** Inserts an edge; `distance` defaults to the geometry's own length. */
const insertEdge = (client, options) =>
  client.query(
    `INSERT INTO routing_edges (
       code, source_vertex_id, target_vertex_id, geometry,
       distance_meters, normal_duration_seconds, rush_hour_duration_seconds,
       bidirectional, reverse_normal_duration_seconds, reverse_rush_hour_duration_seconds
     )
     VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromText($4), 4326),
       COALESCE($5::numeric, ST_Length(ST_SetSRID(ST_GeomFromText($4), 4326)::geography)),
       $6, $7, $8, $9, $10)`,
    [
      options.code,
      options.source,
      options.target,
      options.wkt,
      options.distance ?? null,
      options.normal ?? 60,
      options.rush ?? 90,
      options.bidirectional ?? false,
      options.reverseNormal ?? null,
      options.reverseRush ?? null,
    ],
  );

before(async () => {
  await prepareDatabase();
});

after(async () => {
  await closePool();
});

describe('PostGIS', () => {
  it('is enabled', async () => {
    const { rows } = await pool.query(
      `SELECT extversion FROM pg_extension WHERE extname = 'postgis'`,
    );

    assert.ok(rows[0], 'the postgis extension must be installed');
    assert.match(rows[0].extversion, /^3\./);
  });

  it('has pgRouting installed alongside it, from the routing milestone', async () => {
    // This assertion used to pin the opposite -- that pathfinding was deferred.
    // The routing milestone lifted that boundary; the location tables themselves
    // are unchanged, and the routing suite covers the new extension's behaviour.
    const { rows } = await pool.query(
      `SELECT extversion FROM pg_extension WHERE extname = 'pgrouting'`,
    );

    assert.ok(rows[0], 'the pgrouting extension must be installed');
    assert.match(rows[0].extversion, /^3\./);
  });
});

describe('spatial column types', () => {
  it('stores service point locations as WGS84 geography points', async () => {
    const column = await geographyColumn('service_points', 'location');

    assert.ok(column, 'service_points.location should be a geography column');
    assert.strictEqual(column.type.toLowerCase(), 'point');
    assert.strictEqual(column.srid, 4326);
  });

  it('stores zone centres as WGS84 geography points', async () => {
    const column = await geographyColumn('service_zones', 'center_location');

    assert.ok(column, 'service_zones.center_location should be a geography column');
    assert.strictEqual(column.type.toLowerCase(), 'point');
    assert.strictEqual(column.srid, 4326);
  });

  it('stores vertex locations as WGS84 geometry points', async () => {
    const column = await geometryColumn('routing_vertices', 'location');

    assert.ok(column, 'routing_vertices.location should be a geometry column');
    assert.strictEqual(column.type.toLowerCase(), 'point');
    assert.strictEqual(column.srid, 4326);
  });

  it('stores edge geometry as WGS84 LineStrings', async () => {
    const column = await geometryColumn('routing_edges', 'geometry');

    assert.ok(column, 'routing_edges.geometry should be a geometry column');
    assert.strictEqual(column.type.toLowerCase(), 'linestring');
    assert.strictEqual(column.srid, 4326);
  });
});

describe('spatial indexes', () => {
  it('has a GiST index on service point location', async () => {
    assert.ok(await hasIndex('service_points', 'gist', 'location'));
  });

  it('has a GiST index on zone centre location', async () => {
    assert.ok(await hasIndex('service_zones', 'gist', 'center_location'));
  });

  it('has a GiST index on vertex location', async () => {
    assert.ok(await hasIndex('routing_vertices', 'gist', 'location'));
  });

  it('has a GiST index on edge geometry', async () => {
    assert.ok(await hasIndex('routing_edges', 'gist', 'geometry'));
  });

  it('has the relational indexes the graph queries need', async () => {
    const required = [
      ['service_points', 'zone_id'],
      ['service_points', 'routing_vertex_id'],
      ['service_zones', 'active'],
      ['routing_vertices', 'active'],
      ['routing_edges', 'source_vertex_id'],
      ['routing_edges', 'target_vertex_id'],
      ['routing_edges', 'active'],
    ];

    for (const [table, column] of required) {
      const { rows } = await pool.query(
        `SELECT pg_get_indexdef(x.indexrelid) AS definition
           FROM pg_index x JOIN pg_class c ON c.oid = x.indrelid
          WHERE c.relname = $1`,
        [table],
      );
      assert.ok(
        rows.some((row) => row.definition.includes(column)),
        `${table} should be indexed on ${column}`,
      );
    }
  });
});

describe('coordinate order', () => {
  it('stores a seeded point with latitude and longitude the right way round', async () => {
    const { rows } = await pool.query(
      `SELECT ST_Y(location::geometry)::float AS latitude,
              ST_X(location::geometry)::float AS longitude
         FROM service_points WHERE code = 'banani-road-11'`,
    );

    assert.strictEqual(rows[0].latitude, BANANI_ROAD_11.latitude);
    assert.strictEqual(rows[0].longitude, BANANI_ROAD_11.longitude);
  });

  it('keeps every stored point inside the Dhaka box, which a swap would break', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS swapped FROM service_points
        WHERE ST_Y(location::geometry) NOT BETWEEN 23.6 AND 23.95
           OR ST_X(location::geometry) NOT BETWEEN 90.3 AND 90.5`,
    );

    assert.strictEqual(rows[0].swapped, 0);
  });
});

describe('proximity queries in metres', () => {
  it('finds nearby points inside a one kilometre radius', async () => {
    const { rows } = await pool.query(
      `SELECT code FROM service_points
        WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 1000)
        ORDER BY code`,
      [BANANI_ROAD_11.longitude, BANANI_ROAD_11.latitude],
    );
    const codes = rows.map((row) => row.code);

    assert.ok(codes.includes('banani-road-11'), 'the origin itself must match');
    assert.ok(codes.includes('banani-kakoli'), 'a point a few hundred metres away must match');
  });

  it('excludes a distant point from the same radius', async () => {
    const { rows } = await pool.query(
      `SELECT code FROM service_points
        WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 1000)`,
      [BANANI_ROAD_11.longitude, BANANI_ROAD_11.latitude],
    );
    const codes = rows.map((row) => row.code);

    // Uttara is about eight kilometres north of Banani.
    assert.ok(!codes.includes('house-building'), 'a point kilometres away must not match');
    assert.ok(!codes.includes('shapla-chattar'));
  });

  it('measures distance in metres, not degrees', async () => {
    const { rows } = await pool.query(
      `SELECT ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)::float AS metres
         FROM service_points WHERE code = 'banani-kakoli'`,
      [BANANI_ROAD_11.longitude, BANANI_ROAD_11.latitude],
    );

    // Roughly 450 m apart. In degrees this would be ~0.004.
    assert.ok(rows[0].metres > 200 && rows[0].metres < 800, `expected metres, got ${rows[0].metres}`);
  });
});

describe('spatial constraints', () => {
  it('documents that geography normalises out-of-range input rather than rejecting it', async () => {
    // Deliberately surprising PostGIS behaviour, and the reason coordinates are
    // validated in the application before they are ever stored: casting an
    // out-of-range point to geography silently corrects it instead of failing.
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `SELECT ST_Y((ST_SetSRID(ST_MakePoint(90.4, 95), 4326)::geography)::geometry)::float AS latitude,
                ST_X((ST_SetSRID(ST_MakePoint(190, 23.8), 4326)::geography)::geometry)::float AS longitude`,
      );

      assert.strictEqual(rows[0].latitude, 85, 'latitude 95 is normalised, not rejected');
      assert.strictEqual(rows[0].longitude, -170, 'longitude 190 is wrapped, not rejected');
    });
  });

  it('rejects out-of-range coordinates on a plain geometry column', async () => {
    // routing_vertices.location is `geometry`, which does NOT normalise, so the
    // range checks there are real and do fire.
    await withRollback(async (client) => {
      await expectPgError(
        client,
        () =>
          client.query(
            `INSERT INTO routing_vertices (code, location)
             VALUES ('test-schema-bad-lat', ST_SetSRID(ST_MakePoint(90.4, 95), 4326))`,
          ),
        '23514',
      );

      await expectPgError(
        client,
        () =>
          client.query(
            `INSERT INTO routing_vertices (code, location)
             VALUES ('test-schema-bad-lon', ST_SetSRID(ST_MakePoint(190, 23.8), 4326))`,
          ),
        '23514',
      );
    });
  });

  it('rejects a service point that references a missing zone', async () => {
    await withRollback(async (client) => {
      const vertexId = await createVertex(client, 'test-schema-orphan-point');

      await expectPgError(
        client,
        () =>
          client.query(
            `INSERT INTO service_points (zone_id, routing_vertex_id, code, name, location)
             VALUES ($1, $2, 'test-orphan-point', 'Orphan',
                     ST_SetSRID(ST_MakePoint(90.4, 23.8), 4326)::geography)`,
            ['00000000-0000-0000-0000-000000000000', vertexId],
          ),
        '23503',
      );
    });
  });

  it('rejects a service point that references a missing vertex', async () => {
    await withRollback(async (client) => {
      const zoneId = await createZone(client, 'test-schema-orphan-vertex');

      await expectPgError(
        client,
        () =>
          client.query(
            `INSERT INTO service_points (zone_id, routing_vertex_id, code, name, location)
             VALUES ($1, $2, 'test-orphan-vertex', 'Orphan',
                     ST_SetSRID(ST_MakePoint(90.4, 23.8), 4326)::geography)`,
            [zoneId, '00000000-0000-0000-0000-000000000000'],
          ),
        '23503',
      );
    });
  });

  it('rejects a self-loop edge', async () => {
    await withRollback(async (client) => {
      const vertexId = await createVertex(client, 'test-schema-self-loop');

      await expectPgError(
        client,
        () =>
          insertEdge(client, {
            code: 'test-schema-self-loop',
            source: vertexId,
            target: vertexId,
            wkt: 'LINESTRING(90.4 23.8, 90.41 23.81)',
          }),
        '23514',
      );
    });
  });

  it('rejects a LineString with fewer than two points', async () => {
    await withRollback(async (client) => {
      const source = await createVertex(client, 'test-schema-one-point-a');
      const target = await createVertex(client, 'test-schema-one-point-b');

      // PostGIS refuses this WKT at parse time, before any CHECK constraint is
      // reached, so the SQLSTATE is XX000 rather than a check violation. The
      // routing_edges_line_has_two_points constraint is belt-and-braces behind
      // the geometry(LineString, 4326) type modifier.
      await expectPgError(
        client,
        () =>
          insertEdge(client, {
            code: 'test-schema-one-point',
            source,
            target,
            wkt: 'LINESTRING(90.4 23.8)',
          }),
        'XX000',
      );
    });
  });

  it('rejects a rush-hour duration faster than the normal one', async () => {
    await withRollback(async (client) => {
      const source = await createVertex(client, 'test-schema-duration-a');
      const target = await createVertex(client, 'test-schema-duration-b');

      await expectPgError(
        client,
        () =>
          insertEdge(client, {
            code: 'test-schema-bad-duration',
            source,
            target,
            wkt: 'LINESTRING(90.4 23.8, 90.41 23.81)',
            normal: 120,
            rush: 60,
          }),
        '23514',
      );
    });
  });

  it('rejects a distance that disagrees with the geometry', async () => {
    await withRollback(async (client) => {
      const source = await createVertex(client, 'test-schema-distance-a');
      const target = await createVertex(client, 'test-schema-distance-b');

      await expectPgError(
        client,
        () =>
          insertEdge(client, {
            code: 'test-schema-bad-distance',
            source,
            target,
            wkt: 'LINESTRING(90.4 23.8, 90.41 23.81)',
            distance: 999_999,
          }),
        '23514',
      );
    });
  });

  it('rejects a bidirectional edge with no reverse durations', async () => {
    await withRollback(async (client) => {
      const source = await createVertex(client, 'test-schema-reverse-a');
      const target = await createVertex(client, 'test-schema-reverse-b');

      await expectPgError(
        client,
        () =>
          insertEdge(client, {
            code: 'test-schema-missing-reverse',
            source,
            target,
            wkt: 'LINESTRING(90.4 23.8, 90.41 23.81)',
            bidirectional: true,
          }),
        '23514',
      );
    });
  });

  it('rejects a one-way edge that carries reverse durations', async () => {
    await withRollback(async (client) => {
      const source = await createVertex(client, 'test-schema-oneway-a');
      const target = await createVertex(client, 'test-schema-oneway-b');

      await expectPgError(
        client,
        () =>
          insertEdge(client, {
            code: 'test-schema-unexpected-reverse',
            source,
            target,
            wkt: 'LINESTRING(90.4 23.8, 90.41 23.81)',
            bidirectional: false,
            reverseNormal: 60,
            reverseRush: 90,
          }),
        '23514',
      );
    });
  });

  it('rejects duplicate codes', async () => {
    await withRollback(async (client) => {
      await createZone(client, 'test-schema-duplicate-zone');
      await expectPgError(client, () => createZone(client, 'test-schema-duplicate-zone'), '23505');
    });
  });
});
