import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { TRAFFIC_PROFILE, resolveTrafficProfile } from '../utils/time.js';

/**
 * Point-to-point route estimation over the stored routing graph.
 *
 * This is the only place that talks to pgRouting. It does not price anything:
 * there is no fare, no ride request, no pool and no matching in this milestone.
 *
 * ---------------------------------------------------------------------------
 * HOW A ROUTE IS CALCULATED
 * ---------------------------------------------------------------------------
 * 1. both ServicePoints are loaded (one query) and checked for existence,
 *    active state and an active RoutingVertex;
 * 2. a single traffic profile -- NORMAL or RUSH_HOUR -- is chosen from the
 *    departure instant in Asia/Dhaka;
 * 3. pgr_dijkstra walks *active* edges using that profile's durations as cost;
 * 4. the returned edge identifiers are loaded in one query and put back into
 *    path order with the sequence pgRouting returned;
 * 5. each edge's geometry is oriented the way it was traversed, and its
 *    direction-specific duration is selected;
 * 6. the legs are merged into one LineString, and distance, duration and
 *    arrival time are derived from the traversed legs only.
 *
 * Cost is always duration. `distance_meters` and `fare_weight` are never used
 * as a routing cost, and straight-line distance is never reported as travel
 * distance.
 *
 * ---------------------------------------------------------------------------
 * SQL SAFETY
 * ---------------------------------------------------------------------------
 * `pgr_dijkstra` takes its edge set as SQL *text*, which makes interpolation
 * tempting and dangerous. Nothing here interpolates anything: the two edge
 * queries below are complete, fixed, application-controlled statements, one per
 * traffic profile, with no client input anywhere in them. They are passed as a
 * bind parameter (`$1`) alongside the two integer node identifiers, so the
 * statement text itself is a constant in this file.
 */

/** Which way an edge was traversed, relative to its stored source -> target. */
export const TRAVERSAL_DIRECTION = Object.freeze({
  FORWARD: 'FORWARD',
  BACKWARD: 'BACKWARD',
});

/**
 * One message for every internal failure, so a driver error, a stack trace or a
 * fragment of SQL can never reach a client. The detail is logged instead.
 */
export const ROUTE_FAILURE_MESSAGE = 'Route calculation failed';

const routeFailure = (reason) => {
  console.error('[routing]', reason);
  return new ApiError(500, ROUTE_FAILURE_MESSAGE);
};

/** The two fixed pgRouting edge queries. Nothing client-supplied is ever added. */
const EDGE_QUERY_NORMAL = `
  SELECT e.graph_edge_id AS id,
         s.graph_node_id AS source,
         t.graph_node_id AS target,
         e.normal_duration_seconds::float8 AS cost,
         CASE
           WHEN e.bidirectional THEN e.reverse_normal_duration_seconds::float8
           ELSE -1
         END AS reverse_cost
    FROM routing_edges e
    JOIN routing_vertices s ON s.id = e.source_vertex_id
    JOIN routing_vertices t ON t.id = e.target_vertex_id
   WHERE e.active AND s.active AND t.active
`;

const EDGE_QUERY_RUSH_HOUR = `
  SELECT e.graph_edge_id AS id,
         s.graph_node_id AS source,
         t.graph_node_id AS target,
         e.rush_hour_duration_seconds::float8 AS cost,
         CASE
           WHEN e.bidirectional THEN e.reverse_rush_hour_duration_seconds::float8
           ELSE -1
         END AS reverse_cost
    FROM routing_edges e
    JOIN routing_vertices s ON s.id = e.source_vertex_id
    JOIN routing_vertices t ON t.id = e.target_vertex_id
   WHERE e.active AND s.active AND t.active
`;

/**
 * `reverse_cost = -1` is what makes a one-way edge one-way: pgRouting treats a
 * negative reverse cost as "not traversable in this direction", so the return
 * leg of a directed edge is genuinely unavailable rather than merely expensive.
 */
const EDGE_QUERIES = Object.freeze({
  [TRAFFIC_PROFILE.NORMAL]: EDGE_QUERY_NORMAL,
  [TRAFFIC_PROFILE.RUSH_HOUR]: EDGE_QUERY_RUSH_HOUR,
});

const DIJKSTRA_SQL = `
  SELECT seq,
         path_seq,
         node::bigint AS node,
         edge::bigint AS edge
    FROM pgr_dijkstra($1::text, $2::bigint, $3::bigint, directed := true)
   ORDER BY seq
`;

// pgr_dijkstra marks the final row of a path with this sentinel: it names the
// destination node without arriving there along an edge.
const NO_EDGE = -1;

const isNoEdge = (edge) => Number(edge) === NO_EDGE;

const POINT_LOOKUP_SQL = `
  SELECT p.code,
         p.name,
         p.active AS point_active,
         v.active AS vertex_active,
         v.graph_node_id
    FROM service_points p
    LEFT JOIN routing_vertices v ON v.id = p.routing_vertex_id
   WHERE p.code IN ($1::text, $2::text)
`;

/**
 * Loads exactly the edges on the path, in one query. The identifier list comes
 * from pgRouting, not from a client, and is bound as an array parameter. The
 * endpoint node identifiers are fetched with the edge so the traversal
 * direction can be derived without a second lookup.
 */
const PATH_EDGES_SQL = `
  SELECT e.graph_edge_id,
         e.code,
         e.distance_meters,
         e.normal_duration_seconds,
         e.rush_hour_duration_seconds,
         e.reverse_normal_duration_seconds,
         e.reverse_rush_hour_duration_seconds,
         s.graph_node_id AS source_graph_node_id,
         t.graph_node_id AS target_graph_node_id,
         ST_AsGeoJSON(e.geometry) AS geometry
    FROM routing_edges e
    JOIN routing_vertices s ON s.id = e.source_vertex_id
    JOIN routing_vertices t ON t.id = e.target_vertex_id
   WHERE e.graph_edge_id = ANY($1::bigint[])
`;

/**
 * Prisma's PostgreSQL adapter returns bigint columns as BigInt. Graph
 * identifiers are small by construction, so they are normalised to numbers --
 * which also keeps them comparable with the values pgRouting echoes back.
 */
const asGraphId = (value, label) => {
  const id = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(id) || id <= 0) throw routeFailure(`${label} is not a positive integer: ${value}`);
  return id;
};

/**
 * Runs the Dijkstra query with a PostgreSQL statement timeout scoped to a short
 * transaction. `set_config(..., is_local => true)` is used rather than `SET
 * LOCAL` because it takes the value as a bind parameter, and the transaction is
 * given its own ceiling just above the statement timeout.
 */
const runPathQuery = async (edgesQuery, startNodeId, endNodeId) => {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT set_config('statement_timeout', $1, true)`,
          `${env.routing.statementTimeoutMs}ms`,
        );
        return tx.$queryRawUnsafe(DIJKSTRA_SQL, edgesQuery, startNodeId, endNodeId);
      },
      { timeout: env.routing.queryTimeoutMs },
    );
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw routeFailure(`pgr_dijkstra failed: ${err.message}`);
  }
};

/** Resolves one ServicePoint to a routable endpoint, or throws the matching error. */
const toRoutableEndpoint = (row, code) => {
  if (!row) throw new ApiError(404, `Service point "${code}" was not found`);
  if (!row.point_active) throw new ApiError(409, `Service point "${code}" is inactive`);
  if (row.graph_node_id === null || row.graph_node_id === undefined) {
    throw routeFailure(`service point "${code}" has no routing vertex`);
  }
  if (!row.vertex_active) {
    throw new ApiError(409, `Service point "${code}" is not available for routing right now`);
  }

  return { code: row.code, name: row.name, graphNodeId: asGraphId(row.graph_node_id, 'graph node id') };
};

const loadEndpoints = async (originCode, destinationCode) => {
  const rows = await prisma.$queryRawUnsafe(POINT_LOOKUP_SQL, originCode, destinationCode);

  return {
    origin: toRoutableEndpoint(rows.find((row) => row.code === originCode), originCode),
    destination: toRoutableEndpoint(rows.find((row) => row.code === destinationCode), destinationCode),
  };
};

/**
 * Turns PostGIS LineString output into a validated list of `[longitude, latitude]`
 * positions. GeoJSON positions are x,y -- longitude first -- which is the order
 * the API returns them in.
 */
const parseEdgeCoordinates = (rawGeometry, edgeCode) => {
  let geometry;
  try {
    geometry = JSON.parse(rawGeometry);
  } catch {
    throw routeFailure(`edge "${edgeCode}" has unreadable geometry`);
  }

  if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
    throw routeFailure(`edge "${edgeCode}" is not a LineString`);
  }

  const coordinates = geometry.coordinates.map((position, index) => {
    if (!Array.isArray(position) || position.length < 2) {
      throw routeFailure(`edge "${edgeCode}" position ${index} is malformed`);
    }
    const [longitude, latitude] = position.map(Number);
    if (
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      Math.abs(longitude) > 180 ||
      Math.abs(latitude) > 90
    ) {
      throw routeFailure(`edge "${edgeCode}" position ${index} is outside the WGS84 range`);
    }
    return [longitude, latitude];
  });

  if (coordinates.length < 2) throw routeFailure(`edge "${edgeCode}" has fewer than two positions`);
  return coordinates;
};

/** The duration of a traversed edge, in seconds, for the chosen profile. */
const selectedDurationSeconds = (edge, trafficProfile, direction) => {
  const forward = direction === TRAVERSAL_DIRECTION.FORWARD;
  const rushHour = trafficProfile === TRAFFIC_PROFILE.RUSH_HOUR;

  const raw = rushHour
    ? forward
      ? edge.rush_hour_duration_seconds
      : edge.reverse_rush_hour_duration_seconds
    : forward
      ? edge.normal_duration_seconds
      : edge.reverse_normal_duration_seconds;

  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    // A one-way edge reached backwards has a NULL reverse duration, so this also
    // catches a graph that disagrees with the direction pgRouting reported.
    throw routeFailure(`edge "${edge.code}" has no usable duration for ${trafficProfile} (${direction})`);
  }
  return seconds;
};

const selectedDistanceMeters = (edge) => {
  const meters = Math.round(Number(edge.distance_meters));
  if (!Number.isFinite(meters) || meters <= 0) {
    throw routeFailure(`edge "${edge.code}" has no usable distance`);
  }
  return meters;
};

const loadPathEdges = async (graphEdgeIds) => {
  const rows = await prisma.$queryRawUnsafe(PATH_EDGES_SQL, graphEdgeIds);
  return new Map(rows.map((row) => [asGraphId(row.graph_edge_id, 'graph edge id'), row]));
};

/**
 * Walks the pgRouting rows and produces one leg per traversed edge, in path
 * order.
 *
 * `path[i].node` is the node the path is standing on before traversing
 * `path[i].edge`, and `path[i + 1].node` is the node it arrives at, so the pair
 * is what identifies the traversal direction -- it is never guessed from
 * database order.
 */
const buildLegs = (path, edgesById, trafficProfile) => {
  const legs = [];

  for (let index = 0; index < path.length; index += 1) {
    const step = path[index];
    if (isNoEdge(step.edge)) continue;

    const edgeId = asGraphId(step.edge, 'path edge id');
    const edge = edgesById.get(edgeId);
    if (!edge) throw routeFailure(`path references routing edge ${edgeId}, which does not exist`);

    const fromNodeId = asGraphId(step.node, 'path node id');
    const arrivesAt = path[index + 1];
    if (!arrivesAt) throw routeFailure(`path edge ${edgeId} has no arrival node`);
    const toNodeId = asGraphId(arrivesAt.node, 'path node id');

    const sourceNodeId = asGraphId(edge.source_graph_node_id, `edge "${edge.code}" source`);
    const targetNodeId = asGraphId(edge.target_graph_node_id, `edge "${edge.code}" target`);

    // Edges are stored source -> target, so the node the path stands on before
    // the step is what says whether it was traversed forwards or backwards.
    // This is read from the pgRouting sequence, never guessed from row order.
    const direction =
      fromNodeId === sourceNodeId && toNodeId === targetNodeId
        ? TRAVERSAL_DIRECTION.FORWARD
        : fromNodeId === targetNodeId && toNodeId === sourceNodeId
          ? TRAVERSAL_DIRECTION.BACKWARD
          : null;

    if (direction === null) {
      throw routeFailure(
        `path traverses edge "${edge.code}" between nodes ${fromNodeId} and ${toNodeId}, which are not its endpoints`,
      );
    }

    const coordinates = parseEdgeCoordinates(edge.geometry, edge.code);

    legs.push({
      sequence: legs.length + 1,
      edgeCode: edge.code,
      direction,
      distanceMeters: selectedDistanceMeters(edge),
      durationSeconds: selectedDurationSeconds(edge, trafficProfile, direction),
      // The stored geometry always runs source -> target, so a backwards leg is
      // oriented by reversing it. That is what keeps the merged route in travel
      // order instead of zig-zagging.
      coordinates:
        direction === TRAVERSAL_DIRECTION.FORWARD ? coordinates : [...coordinates].reverse(),
    });
  }

  return legs;
};

/** Positions closer together than this are the same point of the merged line. */
const SAME_POSITION_EPSILON = 1e-9;

const isSamePosition = (a, b) =>
  Math.abs(a[0] - b[0]) <= SAME_POSITION_EPSILON && Math.abs(a[1] - b[1]) <= SAME_POSITION_EPSILON;

/**
 * Concatenates the legs into one ordered LineString.
 *
 * The joins are made here, in travel order, rather than by asking PostGIS to
 * merge a set of edges -- `ST_LineMerge` has no idea which way round the route
 * was travelled and would return a MultiLineString as soon as one edge was
 * traversed backwards. Because every edge endpoint is the same stored vertex
 * coordinate, consecutive legs repeat exactly one position, which is dropped.
 */
export const assembleRouteCoordinates = (legs) => {
  const coordinates = [];

  for (const leg of legs) {
    for (const position of leg.coordinates) {
      if (coordinates.length > 0 && isSamePosition(coordinates.at(-1), position)) continue;
      coordinates.push(position);
    }
  }

  return coordinates;
};

/** Rejects anything that is not a usable LineString before it is returned. */
const toRouteGeometry = (coordinates) => {
  if (coordinates.length < 2) {
    throw routeFailure('the assembled route geometry has fewer than two positions');
  }

  const seen = new Set();
  for (const [longitude, latitude] of coordinates) {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw routeFailure('the assembled route geometry contains a non-finite position');
    }
    seen.add(`${longitude},${latitude}`);
  }
  if (seen.size < 2) throw routeFailure('the assembled route geometry has no length');

  return { type: 'LineString', coordinates };
};

/**
 * Estimates a point-to-point route.
 *
 * Returns the parts of the answer that are routing facts. Formatting -- rounding
 * to kilometres, ISO timestamps, arrival time -- belongs to the serializer.
 */
export const estimateRoute = async ({
  originServicePointCode,
  destinationServicePointCode,
  departureAt,
}) => {
  const { origin, destination } = await loadEndpoints(
    originServicePointCode,
    destinationServicePointCode,
  );

  if (origin.code === destination.code) {
    throw new ApiError(
      400,
      `originServicePointCode and destinationServicePointCode must differ (both are "${origin.code}")`,
    );
  }

  const trafficProfile = resolveTrafficProfile(departureAt, env.routing.rushHourWindows);

  const path = await runPathQuery(
    EDGE_QUERIES[trafficProfile],
    origin.graphNodeId,
    destination.graphNodeId,
  );

  // pgRouting returns no rows -- or a single row naming the start node -- when
  // the destination cannot be reached without crossing a one-way edge the wrong
  // way. The graph is weakly connected, so that is a real answer, not a failure.
  const edgeIds = path
    .filter((step) => !isNoEdge(step.edge))
    .map((step) => asGraphId(step.edge, 'path edge id'));

  if (edgeIds.length === 0) {
    throw new ApiError(422, `No route from "${origin.code}" to "${destination.code}"`);
  }

  const legs = buildLegs(path, await loadPathEdges(edgeIds), trafficProfile);

  if (legs.length !== edgeIds.length) {
    throw routeFailure(
      `pgRouting returned ${edgeIds.length} edge(s) but only ${legs.length} could be assembled`,
    );
  }

  return {
    origin: { code: origin.code, name: origin.name },
    destination: { code: destination.code, name: destination.name },
    departureAt,
    trafficProfile,
    distanceMeters: legs.reduce((total, leg) => total + leg.distanceMeters, 0),
    durationSeconds: legs.reduce((total, leg) => total + leg.durationSeconds, 0),
    geometry: toRouteGeometry(assembleRouteCoordinates(legs)),
    legs: legs.map(({ sequence, edgeCode, direction, distanceMeters, durationSeconds }) => ({
      sequence,
      edgeCode,
      direction,
      distanceMeters,
      durationSeconds,
    })),
  };
};
