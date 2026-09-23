/**
 * Transport-network seed data (the single source of truth for seeded zones,
 * stops, corridors and travel estimates).
 *
 * ---------------------------------------------------------------------------
 * DEMO DATA ONLY -- NOT VERIFIED NAVIGATION DATA
 * ---------------------------------------------------------------------------
 * The MVP deliberately has no maps, geocoding, routing APIs or live traffic.
 * Therefore:
 *   * every `latitude` / `longitude` below is an approximate, unverified
 *     placeholder included only so the nullable columns are exercised;
 *   * every corridor order and every travel estimate (minutes, kilometres,
 *     fare) is a hand-written placeholder for demo purposes;
 *   * none of these values come from a real routing engine and none of them
 *     should be treated as a real navigation or pricing answer.
 *
 * Keep every estimate in `seedTravelEstimates` below so they can be reviewed
 * and changed in one place. `seedCorridorStops` is also the only place that
 * defines the demo corridor order -- stops are stored in `corridor_stops`
 * with a derived 1-based position, never as JSON.
 *
 * All records are upserted by their stable `code` (see
 * ./transport-network.seed.js), so editing a value here and re-running
 * `npm run db:seed` updates the existing rows instead of adding duplicates.
 */

/** Zones: Banani, Gulshan, Mohakhali. */
export const seedZones = [
  { code: 'banani', name: 'Banani', active: true },
  { code: 'gulshan', name: 'Gulshan', active: true },
  { code: 'mohakhali', name: 'Mohakhali', active: true },
];

/** Stops, each belonging to exactly one zone. Coordinates are placeholders. */
export const seedStops = [
  {
    code: 'banani-road-11',
    zoneCode: 'banani',
    name: 'Banani Road 11',
    latitude: 23.7937,
    longitude: 90.4043,
    active: true,
  },
  {
    code: 'banani-kakoli',
    zoneCode: 'banani',
    name: 'Banani Kakoli',
    latitude: 23.7897,
    longitude: 90.4039,
    active: true,
  },
  {
    code: 'banani-chairman-bari',
    zoneCode: 'banani',
    name: 'Banani Chairman Bari',
    latitude: 23.7859,
    longitude: 90.4023,
    active: true,
  },
  {
    code: 'gulshan-1',
    zoneCode: 'gulshan',
    name: 'Gulshan 1',
    latitude: 23.7807,
    longitude: 90.4151,
    active: true,
  },
  {
    code: 'mohakhali-wireless-gate',
    zoneCode: 'mohakhali',
    name: 'Mohakhali Wireless Gate',
    latitude: 23.7779,
    longitude: 90.4061,
    active: true,
  },
  {
    code: 'mohakhali-bus-terminal',
    zoneCode: 'mohakhali',
    name: 'Mohakhali Bus Terminal',
    latitude: 23.774,
    longitude: 90.4006,
    active: true,
  },
];

/** Corridors. The demo corridor is one-way (A -> B); it has no reverse twin. */
export const seedCorridors = [
  {
    code: 'northbound-demo',
    name: 'Northbound demo corridor (Banani Road 11 -> Mohakhali Bus Terminal)',
    active: true,
  },
];

/**
 * Ordered stop membership per corridor code: array index + 1 becomes the
 * `corridor_stops.position`.
 *
 * DEMO ORDER, NOT VERIFIED NAVIGATION: this is a plausible northbound chain
 * through the seeded stops, chosen so the demo trips in `seedTravelEstimates`
 * have a matching corridor. A real product would derive it from road data.
 */
export const seedCorridorStops = {
  'northbound-demo': [
    'banani-road-11', // position 1
    'banani-kakoli', // position 2
    'banani-chairman-bari', // position 3
    'gulshan-1', // position 4
    'mohakhali-wireless-gate', // position 5
    'mohakhali-bus-terminal', // position 6
  ],
};

/**
 * Directional travel estimates -- PLACEHOLDER VALUES.
 * Only the directions listed here exist: there is intentionally no reverse
 * (B -> A) record, and a reversed journey must not resolve to this one.
 *
 * Covers the demo trips:
 *   Banani Road 11   -> Gulshan 1
 *   Banani Road 11   -> Mohakhali Bus Terminal
 *   Banani Kakoli    -> Gulshan 1
 *   Banani Kakoli    -> Mohakhali Wireless Gate
 *   Gulshan 1        -> Mohakhali Wireless Gate
 *   Mohakhali Wireless Gate -> Mohakhali Bus Terminal
 */
export const seedTravelEstimates = [
  {
    fromStopCode: 'banani-road-11',
    toStopCode: 'gulshan-1',
    estimatedMinutes: 18,
    estimatedDistanceKm: 5.4,
    baseFare: 165,
    currency: 'BDT',
  },
  {
    fromStopCode: 'banani-road-11',
    toStopCode: 'mohakhali-bus-terminal',
    estimatedMinutes: 32,
    estimatedDistanceKm: 9.8,
    baseFare: 290,
    currency: 'BDT',
  },
  {
    fromStopCode: 'banani-kakoli',
    toStopCode: 'gulshan-1',
    estimatedMinutes: 15,
    estimatedDistanceKm: 4.6,
    baseFare: 145,
    currency: 'BDT',
  },
  {
    fromStopCode: 'banani-kakoli',
    toStopCode: 'mohakhali-wireless-gate',
    estimatedMinutes: 24,
    estimatedDistanceKm: 7.1,
    baseFare: 215,
    currency: 'BDT',
  },
  {
    fromStopCode: 'gulshan-1',
    toStopCode: 'mohakhali-wireless-gate',
    estimatedMinutes: 12,
    estimatedDistanceKm: 3.9,
    baseFare: 115,
    currency: 'BDT',
  },
  {
    fromStopCode: 'mohakhali-wireless-gate',
    toStopCode: 'mohakhali-bus-terminal',
    estimatedMinutes: 8,
    estimatedDistanceKm: 2.3,
    baseFare: 70,
    currency: 'BDT',
  },
];
