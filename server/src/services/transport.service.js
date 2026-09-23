import { query } from '../db/pool.js';

/**
 * Read-only queries for the transport network (zones, stops, corridors and
 * directional travel estimates).
 *
 * Conventions follow services/user.service.js: plain SQL through the shared
 * pool, rows returned as-is, HTTP status decisions left to the controller.
 */

const STOP_COLUMNS = `
  s.id, s.code, s.name, s.latitude, s.longitude, s.active,
  z.code AS zone_code
`;

const CORRIDOR_COLUMNS = 'c.id, c.code, c.name, c.active';

export const findActiveZones = async () => {
  const { rows } = await query(
    `SELECT id, code, name FROM zones WHERE active ORDER BY name, code`,
  );
  return rows;
};

export const findZoneByCode = async (code) => {
  const { rows } = await query(`SELECT id, code, name, active FROM zones WHERE code = $1`, [code]);
  return rows[0] ?? null;
};

/**
 * Active stops, optionally narrowed to one zone code.
 * Pass `zoneCode: null` for every active stop.
 */
export const findActiveStops = async ({ zoneCode = null } = {}) => {
  const { rows } = await query(
    `SELECT ${STOP_COLUMNS}
       FROM stops s
       JOIN zones z ON z.id = s.zone_id
      WHERE s.active
        AND ($1::text IS NULL OR z.code = $1::text)
      ORDER BY z.name, s.name, s.code`,
    [zoneCode],
  );
  return rows;
};

/**
 * A single stop by code. Returns the row even when it is inactive so the
 * caller can answer 409 ("exists but is switched off") instead of 404.
 */
export const findStopByCode = async (code) => {
  const { rows } = await query(
    `SELECT ${STOP_COLUMNS} FROM stops s JOIN zones z ON z.id = s.zone_id WHERE s.code = $1`,
    [code],
  );
  return rows[0] ?? null;
};

export const findActiveCorridors = async () => {
  const { rows } = await query(
    `SELECT ${CORRIDOR_COLUMNS} FROM corridors c WHERE c.active ORDER BY c.name, c.code`,
  );
  return rows;
};

/** A single corridor by code; inactive corridors are returned so the caller can answer 409. */
export const findCorridorByCode = async (code) => {
  const { rows } = await query(`SELECT ${CORRIDOR_COLUMNS} FROM corridors c WHERE c.code = $1`, [
    code,
  ]);
  return rows[0] ?? null;
};

/**
 * The ordered stop list of a corridor. Inactive stops are omitted from reads,
 * matching the "reject inactive stops" rule of the rest of the feature; the
 * remaining positions keep their stored values so the order stays unambiguous.
 */
export const findCorridorStops = async (corridorId) => {
  const { rows } = await query(
    `SELECT cs.position, ${STOP_COLUMNS}
       FROM corridor_stops cs
       JOIN stops s ON s.id = cs.stop_id
       JOIN zones z ON z.id = s.zone_id
      WHERE cs.corridor_id = $1
        AND s.active
      ORDER BY cs.position`,
    [corridorId],
  );
  return rows;
};

/**
 * Active corridors that contain both stops with the pickup strictly before the
 * drop-off. Direction matters: a one-way corridor never matches the reversed
 * pair, because the comparison is done on corridor positions, not on codes.
 */
export const findCorridorsForStopPair = async (pickupStopId, dropoffStopId) => {
  const { rows } = await query(
    `SELECT c.id, c.code, c.name,
            pickup.position  AS pickup_position,
            dropoff.position AS dropoff_position
       FROM corridors c
       JOIN corridor_stops pickup  ON pickup.corridor_id = c.id AND pickup.stop_id = $1
       JOIN corridor_stops dropoff ON dropoff.corridor_id = c.id AND dropoff.stop_id = $2
      WHERE c.active
        AND pickup.position < dropoff.position
      ORDER BY c.name, c.code`,
    [pickupStopId, dropoffStopId],
  );
  return rows;
};

/**
 * The direct estimate from one stop to another.
 *
 * Travel estimates are directional: there is deliberately no fallback that
 * looks up the reverse pair, so A -> B is not answered by a B -> A record.
 */
export const findTravelEstimate = async (fromStopId, toStopId) => {
  const { rows } = await query(
    `SELECT te.id,
            te.estimated_minutes,
            te.estimated_distance_km,
            te.base_fare,
            te.currency,
            origin.code AS from_stop_code,
            origin.name AS from_stop_name,
            destination.code AS to_stop_code,
            destination.name AS to_stop_name
       FROM travel_estimates te
       JOIN stops origin      ON origin.id = te.from_stop_id
       JOIN stops destination ON destination.id = te.to_stop_id
      WHERE te.from_stop_id = $1
        AND te.to_stop_id = $2`,
    [fromStopId, toStopId],
  );
  return rows[0] ?? null;
};
