/**
 * Response DTOs for the location foundation.
 *
 * The queries already project PostGIS geometries into plain latitude/longitude
 * numbers, so these mappers mostly decide what is exposed. They are whitelists:
 * every field is copied explicitly, so an audit timestamp or a routing column
 * added later cannot leak into a response by accident.
 *
 * Note the naming: `latitude` and `longitude` are always separate named fields,
 * never a positional pair, which is what keeps the longitude-first requirement
 * from being reintroduced by a careless caller.
 */

const toNumber = (value) => Number(value);

export const toZoneDto = (zone) => ({
  id: zone.id,
  code: zone.code,
  name: zone.name,
  latitude: toNumber(zone.latitude),
  longitude: toNumber(zone.longitude),
});

export const toPointDto = (point) => ({
  id: point.id,
  code: point.code,
  name: point.name,
  zoneCode: point.zone_code,
  latitude: toNumber(point.latitude),
  longitude: toNumber(point.longitude),
});
