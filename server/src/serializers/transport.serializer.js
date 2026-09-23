/**
 * Response DTOs for the transport network.
 *
 * The API never exposes raw Prisma records:
 *   * the database shape (nested relations, Decimal instances) is mapped to the
 *     documented camelCase shape;
 *   * internal audit columns (createdAt / updatedAt) are intentionally not
 *     returned -- the existing API convention does not expose timestamps except
 *     in /health;
 *   * Decimal columns reach Node as decimal.js instances, so they are converted
 *     to JSON numbers here. Storage stays exact NUMERIC in PostgreSQL (never
 *     float), which is why the conversion happens at the edge and not in the
 *     database.
 */

const toNumberOrNull = (value) => (value === null || value === undefined ? null : Number(value));

export const toZoneDto = (zone) => ({
  id: zone.id,
  code: zone.code,
  name: zone.name,
});

export const toStopDto = (stop) => ({
  id: stop.id,
  code: stop.code,
  name: stop.name,
  zoneCode: stop.zone?.code ?? null,
  latitude: toNumberOrNull(stop.latitude),
  longitude: toNumberOrNull(stop.longitude),
});

export const toCorridorDto = (corridor) => ({
  id: corridor.id,
  code: corridor.code,
  name: corridor.name,
});

/** Corridor plus its stops in corridor order (positions come from corridor_stops). */
export const toCorridorDetailDto = (corridor, memberships) => ({
  ...toCorridorDto(corridor),
  stops: memberships.map((membership) => ({
    position: membership.position,
    ...toStopDto(membership.stop),
  })),
});

/** One corridor that can carry a pickup -> drop-off pair, with both positions. */
export const toCorridorMatchDto = ({ corridor, pickupPosition, dropoffPosition }) => ({
  corridor: toCorridorDto(corridor),
  pickupPosition,
  dropoffPosition,
});

/** A directional travel estimate. A -> B and B -> A are separate DTOs. */
export const toTravelEstimateDto = (estimate) => ({
  fromStop: { code: estimate.fromStop.code, name: estimate.fromStop.name },
  toStop: { code: estimate.toStop.code, name: estimate.toStop.name },
  estimatedMinutes: estimate.estimatedMinutes,
  estimatedDistanceKm: Number(estimate.estimatedDistanceKm),
  baseFare: Number(estimate.baseFare),
  currency: estimate.currency,
});
