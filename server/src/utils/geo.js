/**
 * Geographic helpers for the location foundation.
 *
 * ---------------------------------------------------------------------------
 * LONGITUDE BEFORE LATITUDE
 * ---------------------------------------------------------------------------
 * PostGIS point constructors take X then Y, i.e. LONGITUDE then LATITUDE:
 *
 *     ST_MakePoint(longitude, latitude)
 *
 * Swapping them is not an error PostGIS will report -- it silently stores a
 * point somewhere else on the planet. That is why nothing in this codebase
 * builds spatial SQL by hand: everything goes through `toPointWkt` /
 * `toLineStringWkt` below, which are the single place the order is decided, and
 * which only ever accept a named `{ latitude, longitude }` pair so a caller
 * cannot pass the two positionally by mistake.
 */

/**
 * Dhaka-area bounds for the demo seed.
 *
 * Deliberately generous: these exist to catch a coordinate that is obviously
 * wrong -- a swapped latitude/longitude, a stray sign, a point in another
 * country -- not to trace the city boundary. A rectangle a little larger than
 * Dhaka does that job without rejecting legitimate neighbourhood points.
 */
export const DHAKA_BOUNDS = Object.freeze({
  minLatitude: 23.6,
  maxLatitude: 23.95,
  minLongitude: 90.3,
  maxLongitude: 90.5,
});

export const isValidLatitude = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;

export const isValidLongitude = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;

export const isWithinDhakaBounds = ({ latitude, longitude }) =>
  isValidLatitude(latitude) &&
  isValidLongitude(longitude) &&
  latitude >= DHAKA_BOUNDS.minLatitude &&
  latitude <= DHAKA_BOUNDS.maxLatitude &&
  longitude >= DHAKA_BOUNDS.minLongitude &&
  longitude <= DHAKA_BOUNDS.maxLongitude;

/** Well-known text for a single point, as PostGIS expects it. */
export const toPointWkt = ({ longitude, latitude }) => `POINT(${longitude} ${latitude})`;

/**
 * Well-known text for a line through the given coordinates.
 * At least two points are required, because LINESTRING(a) is not valid.
 */
export const toLineStringWkt = (coordinates) => {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error('a LineString needs at least two coordinates');
  }

  return `LINESTRING(${coordinates
    .map(({ longitude, latitude }) => `${longitude} ${latitude}`)
    .join(', ')})`;
};

/** Rounds a coordinate to the precision the seed uses. */
export const roundCoordinate = (value) => Number(value.toFixed(6));
