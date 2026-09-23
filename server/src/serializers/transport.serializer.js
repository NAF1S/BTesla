/**
 * Response DTOs for the transport network.
 *
 * The API never exposes raw rows:
 *   * database snake_case columns are mapped to the documented camelCase shape;
 *   * internal audit columns (created_at / updated_at) are intentionally not
 *     returned -- the existing API convention does not expose timestamps
 *     except in /health;
 *   * NUMERIC columns reach Node as strings, so they are converted to JSON
 *     numbers here. Storage stays exact NUMERIC in PostgreSQL (never float).
 */

const toNumberOrNull = (value) => (value === null || value === undefined ? null : Number(value));

export const toZoneDto = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
});

export const toStopDto = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  zoneCode: row.zone_code ?? null,
  latitude: toNumberOrNull(row.latitude),
  longitude: toNumberOrNull(row.longitude),
});

export const toCorridorDto = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
});

/** Corridor plus its stops in corridor order (positions come from corridor_stops). */
export const toCorridorDetailDto = (corridorRow, stopRows) => ({
  ...toCorridorDto(corridorRow),
  stops: stopRows.map((row) => ({
    position: Number(row.position),
    ...toStopDto(row),
  })),
});

/** One corridor that can carry a pickup -> drop-off pair, with both positions. */
export const toCorridorMatchDto = (row) => ({
  corridor: toCorridorDto(row),
  pickupPosition: Number(row.pickup_position),
  dropoffPosition: Number(row.dropoff_position),
});

/** A directional travel estimate. A -> B and B -> A are separate DTOs. */
export const toTravelEstimateDto = (row) => ({
  fromStop: { code: row.from_stop_code, name: row.from_stop_name },
  toStop: { code: row.to_stop_code, name: row.to_stop_name },
  estimatedMinutes: Number(row.estimated_minutes),
  estimatedDistanceKm: Number(row.estimated_distance_km),
  baseFare: Number(row.base_fare),
  currency: row.currency,
});
