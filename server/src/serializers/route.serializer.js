/**
 * Response DTO for a route estimate.
 *
 * Like the location serializer this is a whitelist: every field is copied
 * explicitly, so a routing column added later cannot leak into a response by
 * accident. Graph identifiers (graph node / graph edge ids) are internal and are
 * deliberately never returned -- a client refers to an edge by its stable public
 * `code`, not by an integer that only means something to pgRouting.
 *
 * There are no fare fields here, and there will not be: pricing is a later
 * milestone that this endpoint deliberately knows nothing about.
 *
 * Timestamps are always UTC ISO 8601. Asia/Dhaka is used to decide the traffic
 * profile and for nothing else, so no local time is ever returned.
 */

const METRES_PER_KILOMETRE = 1000;
const SECONDS_PER_MINUTE = 60;

/** Kilometres to the metre -- 4200 m is 4.2 km, not 4.200000000000001. */
const toKilometres = (meters) => Number((meters / METRES_PER_KILOMETRE).toFixed(3));

/** Whole minutes, rounded, so 840 s is 14. */
const toMinutes = (seconds) => Math.round(seconds / SECONDS_PER_MINUTE);

const toIsoString = (date) => new Date(date).toISOString();

export const toRouteEstimateDto = (estimate) => ({
  origin: {
    code: estimate.origin.code,
    name: estimate.origin.name,
  },
  destination: {
    code: estimate.destination.code,
    name: estimate.destination.name,
  },
  departureAt: toIsoString(estimate.departureAt),
  estimatedArrivalAt: toIsoString(
    new Date(new Date(estimate.departureAt).getTime() + estimate.durationSeconds * 1000),
  ),
  trafficProfile: estimate.trafficProfile,
  distanceMeters: estimate.distanceMeters,
  distanceKilometers: toKilometres(estimate.distanceMeters),
  durationSeconds: estimate.durationSeconds,
  durationMinutes: toMinutes(estimate.durationSeconds),
  geometry: {
    type: estimate.geometry.type,
    coordinates: estimate.geometry.coordinates,
  },
  legs: estimate.legs.map((leg) => ({
    sequence: leg.sequence,
    edgeCode: leg.edgeCode,
    direction: leg.direction,
    distanceMeters: leg.distanceMeters,
    durationSeconds: leg.durationSeconds,
  })),
});
