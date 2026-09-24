import { env } from '../../config/env.js';
import {
  DHAKA_BOUNDS,
  isWithinDhakaBounds,
  isValidLatitude,
  isValidLongitude,
  toLineStringWkt,
} from '../../utils/geo.js';
import { DEMO_SPEED_KMH, LOCATION_EDGES, LOCATION_ZONES } from './location.data.js';
import { assignGraphEdgeIds, assignGraphNodeIds } from './graph-ids.js';

/**
 * Idempotent, deterministic seeder for the PostGIS location foundation and the
 * stored routing graph.
 *
 * Order is deliberate and matches the brief:
 *   1. upsert service zones        (centres derived from their own points)
 *   2. upsert routing vertices     (one per point, before anything points at them)
 *   3. upsert service points       (connected to their vertex)
 *   4. upsert routing edges        (distance measured by PostGIS)
 *   5. validate coordinate bounds
 *   6. validate edge geometry and endpoints
 *   7. validate graph connectivity
 *
 * Every step runs inside the caller's transaction, so a failed validation rolls
 * the whole seed back rather than leaving a half-written graph behind.
 *
 * Nothing spatial is hand-built: points and lines go through utils/geo.js, which
 * is the single place longitude-before-latitude is applied.
 *
 * The integer graph identifiers pgRouting needs are assigned here, once, from
 * the codes themselves (see ./graph-ids.js) and are never rewritten: a route
 * result is a list of edge identifiers, so reassigning one would repoint a route
 * that already exists. The database enforces the same rule with a trigger.
 */

const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** How far an edge endpoint may sit from its vertex, in metres. */
export const EDGE_ENDPOINT_TOLERANCE_METERS = 1;

/** Stable, derived identifiers so a code can never disagree with its data. */
export const vertexCode = (pointCode) => `vertex-${pointCode}`;
export const edgeCode = (fromCode, toCode) => `edge-${fromCode}-to-${toCode}`;

/** Flattens the zone tree into a flat point list carrying its zone code. */
export const allSeedPoints = () =>
  LOCATION_ZONES.flatMap((zone) => zone.points.map((point) => ({ ...point, zoneCode: zone.code })));

/** Arithmetic mean of a zone's own points. A demo centroid, not a boundary. */
const zoneCenter = (points) => ({
  latitude: Number((points.reduce((sum, p) => sum + p.latitude, 0) / points.length).toFixed(6)),
  longitude: Number((points.reduce((sum, p) => sum + p.longitude, 0) / points.length).toFixed(6)),
});

/**
 * Rejects malformed seed data before a single row is written, so a typo fails
 * loudly instead of producing a plausible-looking but wrong map.
 */
export const assertSeedDataIsCoherent = () => {
  const zoneCodes = new Set();
  const zoneNames = new Set();
  const pointCodes = new Set();
  const coordinatesByZone = new Map();

  for (const zone of LOCATION_ZONES) {
    if (zoneCodes.has(zone.code)) throw new Error(`Duplicate seed zone code "${zone.code}"`);
    if (zoneNames.has(zone.name)) throw new Error(`Duplicate seed zone name "${zone.name}"`);
    if (!CODE_PATTERN.test(zone.code)) throw new Error(`Seed zone code "${zone.code}" is malformed`);
    zoneCodes.add(zone.code);
    zoneNames.add(zone.name);

    if (!Array.isArray(zone.points) || zone.points.length < 3) {
      throw new Error(`Seed zone "${zone.code}" must have at least three points`);
    }

    const seenNames = new Set();
    const seenCoordinates = new Set();

    for (const point of zone.points) {
      if (pointCodes.has(point.code)) {
        throw new Error(`Duplicate seed point code "${point.code}" (point codes are global)`);
      }
      if (!CODE_PATTERN.test(point.code)) {
        throw new Error(`Seed point code "${point.code}" is malformed`);
      }
      pointCodes.add(point.code);

      if (seenNames.has(point.name)) {
        throw new Error(`Zone "${zone.code}" lists the name "${point.name}" twice`);
      }
      seenNames.add(point.name);

      if (!isValidLatitude(point.latitude) || !isValidLongitude(point.longitude)) {
        throw new Error(`Seed point "${point.code}" has an invalid WGS84 coordinate`);
      }
      if (!isWithinDhakaBounds(point)) {
        throw new Error(
          `Seed point "${point.code}" (${point.latitude}, ${point.longitude}) falls outside the ` +
            `configured Dhaka bounds ${JSON.stringify(DHAKA_BOUNDS)}`,
        );
      }

      // Two points stacked on the same spot would make the graph degenerate.
      const coordinateKey = `${point.latitude},${point.longitude}`;
      if (seenCoordinates.has(coordinateKey)) {
        throw new Error(
          `Zone "${zone.code}" has two points at identical coordinates (${coordinateKey})`,
        );
      }
      seenCoordinates.add(coordinateKey);
    }

    coordinatesByZone.set(zone.code, seenCoordinates);
  }

  const edgeCodes = new Set();
  const edgePairs = new Set();
  const pointsUsedByEdges = new Set();

  for (const edge of LOCATION_EDGES) {
    const label = `${edge.from} -> ${edge.to}`;

    if (!pointCodes.has(edge.from)) throw new Error(`Edge ${label} references unknown point "${edge.from}"`);
    if (!pointCodes.has(edge.to)) throw new Error(`Edge ${label} references unknown point "${edge.to}"`);
    if (edge.from === edge.to) throw new Error(`Edge ${label} is a self-loop`);

    const code = edgeCode(edge.from, edge.to);
    if (!CODE_PATTERN.test(code)) throw new Error(`Derived edge code "${code}" is malformed`);
    if (edgeCodes.has(code)) throw new Error(`Duplicate edge code "${code}"`);
    edgeCodes.add(code);

    // One record per ordered pair: A -> B and B -> A are different edges.
    if (edgePairs.has(`${edge.from}|${edge.to}`)) throw new Error(`Duplicate edge ${label}`);
    edgePairs.add(`${edge.from}|${edge.to}`);

    const fareWeight = edge.fareWeight ?? 1;
    if (!(typeof fareWeight === 'number' && Number.isFinite(fareWeight) && fareWeight > 0)) {
      throw new Error(`Edge ${label} must have a positive fareWeight`);
    }

    pointsUsedByEdges.add(edge.from);
    pointsUsedByEdges.add(edge.to);
  }

  // Every vertex needs at least one edge; catching it here names the point.
  for (const code of pointCodes) {
    if (!pointsUsedByEdges.has(code)) {
      throw new Error(`Seed point "${code}" has no edge, so its vertex would be isolated`);
    }
  }
};

const upsertZone = async (tx, zone) => {
  const center = zoneCenter(zone.points);
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO service_zones (code, name, center_location, active)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, true)
     ON CONFLICT (code) DO UPDATE
       SET name = EXCLUDED.name,
           center_location = EXCLUDED.center_location
     RETURNING id`,
    zone.code,
    zone.name,
    center.longitude,
    center.latitude,
  );
  return rows[0].id;
};

/**
 * Upserts one vertex.
 *
 * graph_node_id is inserted but deliberately left out of the UPDATE list: the
 * identifier is written once and is immutable from then on, which is what keeps
 * it stable across seed runs (and what the immutability trigger enforces).
 */
const upsertVertex = async (tx, point, graphNodeId) => {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO routing_vertices (code, location, graph_node_id, active)
     VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, true)
     ON CONFLICT (code) DO UPDATE
       SET location = EXCLUDED.location
     RETURNING id`,
    vertexCode(point.code),
    point.longitude,
    point.latitude,
    graphNodeId,
  );
  return rows[0].id;
};

const upsertPoint = async (tx, point, zoneId, routingVertexId) => {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO service_points (zone_id, routing_vertex_id, code, name, location, active)
     VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, true)
     ON CONFLICT (code) DO UPDATE
       SET zone_id = EXCLUDED.zone_id,
           routing_vertex_id = EXCLUDED.routing_vertex_id,
           name = EXCLUDED.name,
           location = EXCLUDED.location
     RETURNING id`,
    zoneId,
    routingVertexId,
    point.code,
    point.name,
    point.longitude,
    point.latitude,
  );
  return rows[0].id;
};

/**
 * Upserts one edge.
 *
 * distance_meters is not passed in: it is measured from the geometry with
 * ST_Length(geometry::geography) inside the statement, and the durations are
 * derived from that same measurement using DEMO_SPEED_KMH. A hand-written
 * distance could silently disagree with the shape it describes; this cannot.
 *
 * Reverse durations are populated only for a bidirectional edge, which is what
 * the routing_edges_reverse_durations_consistent constraint requires.
 *
 * graph_edge_id is inserted but never updated: it is the value pgr_dijkstra
 * reports back as `edge`, so it identifies an edge for the lifetime of a route.
 */
const upsertEdge = async (tx, edge, pointCoordinates, vertexIds, graphEdgeId) => {
  const wkt = toLineStringWkt([pointCoordinates.get(edge.from), pointCoordinates.get(edge.to)]);
  const bidirectional = edge.bidirectional ?? true;

  const rows = await tx.$queryRawUnsafe(
    `WITH line AS (
       SELECT ST_SetSRID(ST_GeomFromText($4), 4326) AS g
     )
     INSERT INTO routing_edges (
       code, source_vertex_id, target_vertex_id, geometry,
       distance_meters, normal_duration_seconds, rush_hour_duration_seconds,
       fare_weight, reverse_normal_duration_seconds, reverse_rush_hour_duration_seconds,
       bidirectional, active, metadata, graph_edge_id
     )
     SELECT
       $1, $2, $3, line.g,
       ST_Length(line.g::geography),
       GREATEST(1, round(ST_Length(line.g::geography) / ($5::numeric / 3.6)))::int,
       GREATEST(1, round(ST_Length(line.g::geography) / ($6::numeric / 3.6)))::int,
       $7,
       CASE WHEN $8 THEN GREATEST(1, round(ST_Length(line.g::geography) / ($5::numeric / 3.6)))::int END,
       CASE WHEN $8 THEN GREATEST(1, round(ST_Length(line.g::geography) / ($6::numeric / 3.6)))::int END,
       $8, true, $9::jsonb, $10
     FROM line
     ON CONFLICT (code) DO UPDATE SET
       source_vertex_id = EXCLUDED.source_vertex_id,
       target_vertex_id = EXCLUDED.target_vertex_id,
       geometry = EXCLUDED.geometry,
       distance_meters = EXCLUDED.distance_meters,
       normal_duration_seconds = EXCLUDED.normal_duration_seconds,
       rush_hour_duration_seconds = EXCLUDED.rush_hour_duration_seconds,
       fare_weight = EXCLUDED.fare_weight,
       reverse_normal_duration_seconds = EXCLUDED.reverse_normal_duration_seconds,
       reverse_rush_hour_duration_seconds = EXCLUDED.reverse_rush_hour_duration_seconds,
       bidirectional = EXCLUDED.bidirectional,
       metadata = EXCLUDED.metadata
     RETURNING id`,
    edgeCode(edge.from, edge.to),
    vertexIds.get(edge.from),
    vertexIds.get(edge.to),
    wkt,
    DEMO_SPEED_KMH.normal,
    DEMO_SPEED_KMH.rushHour,
    edge.fareWeight ?? 1,
    bidirectional,
    edge.metadata ? JSON.stringify(edge.metadata) : null,
    graphEdgeId,
  );

  return rows[0].id;
};

/** Rejects anything stored outside the configured Dhaka rectangle. */
const assertStoredCoordinatesWithinBounds = async (tx) => {
  const bounds = [
    DHAKA_BOUNDS.minLatitude,
    DHAKA_BOUNDS.maxLatitude,
    DHAKA_BOUNDS.minLongitude,
    DHAKA_BOUNDS.maxLongitude,
  ];

  const rows = await tx.$queryRawUnsafe(
    `SELECT
       (SELECT count(*)::int FROM service_points
         WHERE NOT (ST_Y(location::geometry) BETWEEN $1 AND $2
                AND ST_X(location::geometry) BETWEEN $3 AND $4)) AS out_of_bounds_points,
       (SELECT count(*)::int FROM service_zones
         WHERE NOT (ST_Y(center_location::geometry) BETWEEN $1 AND $2
                AND ST_X(center_location::geometry) BETWEEN $3 AND $4)) AS out_of_bounds_zones`,
    ...bounds,
  );

  if (rows[0].out_of_bounds_points > 0 || rows[0].out_of_bounds_zones > 0) {
    throw new Error(
      `seeded coordinates fall outside the Dhaka bounds: ${rows[0].out_of_bounds_points} point(s), ` +
        `${rows[0].out_of_bounds_zones} zone(s)`,
    );
  }
};

/** Rejects degenerate lines, self-loops and endpoints detached from their vertex. */
const assertEdgeGeometryIsSound = async (tx) => {
  const rows = await tx.$queryRawUnsafe(
    `SELECT
       (SELECT count(*)::int FROM routing_edges
         WHERE NOT ST_IsValid(geometry) OR ST_NPoints(geometry) < 2) AS malformed_geometry,
       (SELECT count(*)::int FROM routing_edges
         WHERE source_vertex_id = target_vertex_id) AS self_loops,
       (SELECT count(*)::int
          FROM routing_edges e
          JOIN routing_vertices s ON s.id = e.source_vertex_id
          JOIN routing_vertices t ON t.id = e.target_vertex_id
         WHERE ST_Distance(ST_StartPoint(e.geometry)::geography, s.location::geography) > $1
            OR ST_Distance(ST_EndPoint(e.geometry)::geography, t.location::geography) > $1
       ) AS misaligned_endpoints`,
    EDGE_ENDPOINT_TOLERANCE_METERS,
  );

  const { malformed_geometry: malformed, self_loops: selfLoops, misaligned_endpoints: misaligned } = rows[0];
  if (malformed > 0) throw new Error(`${malformed} routing edge(s) have malformed LineString geometry`);
  if (selfLoops > 0) throw new Error(`${selfLoops} routing edge(s) are self-loops`);
  if (misaligned > 0) {
    throw new Error(
      `${misaligned} routing edge(s) start or end further than ${EDGE_ENDPOINT_TOLERANCE_METERS}m from their vertex`,
    );
  }
};

/**
 * Rejects an isolated vertex, a zone with no way out, or a graph that has
 * fragmented into more than one weakly connected component.
 *
 * This traverses the graph with a recursive CTE rather than a routing service:
 * it is a data-integrity check, not pathfinding.
 */
const assertGraphIsConnected = async (tx) => {
  const rows = await tx.$queryRawUnsafe(
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
     SELECT
       (SELECT count(*)::int FROM walk) AS reached,
       (SELECT count(*)::int FROM routing_vertices WHERE active) AS total,
       (SELECT count(*)::int FROM routing_vertices v
         WHERE v.active AND NOT EXISTS (
           SELECT 1 FROM routing_edges e
            WHERE e.active AND (e.source_vertex_id = v.id OR e.target_vertex_id = v.id)
         )) AS isolated_vertices,
       (SELECT count(*)::int FROM service_zones z
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
         )) AS zones_without_a_neighbour`,
  );

  const { reached, total, isolated_vertices: isolated, zones_without_a_neighbour: stranded } = rows[0];

  if (isolated > 0) throw new Error(`${isolated} active routing vertex/vertices have no active edge`);
  if (stranded > 0) throw new Error(`${stranded} active service zone(s) do not connect to another zone`);
  if (reached !== total) {
    throw new Error(
      `the seeded graph is not one weakly connected component: ${reached} of ${total} vertices are reachable`,
    );
  }
};

/**
 * Applies the location seed with the given transaction client.
 *
 * Returns a summary of what was written, which the CLI prints and the tests
 * assert against.
 */
export const seedLocationNetwork = async (tx) => {
  if (env.nodeEnv === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error(
      'refusing to seed demo location data when NODE_ENV=production (set ALLOW_DEMO_SEED=true to override)',
    );
  }

  assertSeedDataIsCoherent();

  // 1. Zones.
  const zoneIds = new Map();
  for (const zone of LOCATION_ZONES) zoneIds.set(zone.code, await upsertZone(tx, zone));

  // 2. Vertices, before any point can reference one. The integer graph
  // identifiers are derived from the codes, in the same order
  // 06-pgrouting-routing.sql uses to backfill a pre-existing graph.
  const graphNodeIds = assignGraphNodeIds(allSeedPoints().map((point) => vertexCode(point.code)));
  const graphEdgeIds = assignGraphEdgeIds(
    LOCATION_EDGES.map((edge) => edgeCode(edge.from, edge.to)),
  );

  const vertexIds = new Map();
  for (const point of allSeedPoints()) {
    vertexIds.set(point.code, await upsertVertex(tx, point, graphNodeIds.get(vertexCode(point.code))));
  }

  // 3. Points, connected to their vertex.
  const pointIds = new Map();
  for (const point of allSeedPoints()) {
    pointIds.set(
      point.code,
      await upsertPoint(tx, point, zoneIds.get(point.zoneCode), vertexIds.get(point.code)),
    );
  }

  // 4. Edges.
  const pointCoordinates = new Map(
    allSeedPoints().map((point) => [
      point.code,
      { latitude: point.latitude, longitude: point.longitude },
    ]),
  );
  let edgeCount = 0;
  for (const edge of LOCATION_EDGES) {
    const code = edgeCode(edge.from, edge.to);
    await upsertEdge(
      tx,
      edge,
      pointCoordinates,
      vertexIds,
      graphEdgeIds.get(code),
    );
    edgeCount += 1;
  }

  // Keep each identifier sequence above what was just written, so an insert that
  // does not name a graph identifier of its own (a fixture, a hand-written row)
  // cannot be handed one that is already taken. The migration does the same for
  // a graph that was already seeded.
  await tx.$queryRawUnsafe(
    `SELECT setval('routing_vertices_graph_node_id_seq',
                   (SELECT max(graph_node_id) FROM routing_vertices))`,
  );
  await tx.$queryRawUnsafe(
    `SELECT setval('routing_edges_graph_edge_id_seq',
                   (SELECT max(graph_edge_id) FROM routing_edges))`,
  );

  // 5-7. Validation. A throw here rolls the whole transaction back.
  await assertStoredCoordinatesWithinBounds(tx);
  await assertEdgeGeometryIsSound(tx);
  await assertGraphIsConnected(tx);

  const bidirectionalEdges = LOCATION_EDGES.filter((edge) => edge.bidirectional ?? true).length;

  return {
    zones: zoneIds.size,
    vertices: vertexIds.size,
    points: pointIds.size,
    edges: edgeCount,
    bidirectionalEdges,
    oneWayEdges: edgeCount - bidirectionalEdges,
  };
};
