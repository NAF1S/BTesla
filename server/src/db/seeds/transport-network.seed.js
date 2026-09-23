import {
  seedCorridorStops,
  seedCorridors,
  seedStops,
  seedTravelEstimates,
  seedZones,
} from './transport-network.data.js';

/**
 * Idempotent, deterministic seeder for the transport network.
 *
 * Guarantees:
 *   * every record is matched by its stable `code` (never by a generated id),
 *     so running this twice updates rows instead of inserting duplicates;
 *   * it only ever touches records it owns, so user-created zones, stops,
 *     corridors or estimates are left alone;
 *   * it runs in a single transaction supplied by the caller, so a failure
 *     leaves the database untouched.
 *
 * Call it with a connected pg client, e.g.
 *   BEGIN; seedTransportNetwork(client); COMMIT;
 */
const PARKING_OFFSET = 10_000;

/**
 * Cheap sanity checks so a typo in the data file fails loudly instead of
 * silently producing a half-usable network.
 */
const assertSeedDataIsCoherent = () => {
  const zoneCodes = new Set();
  for (const zone of seedZones) {
    if (zoneCodes.has(zone.code)) throw new Error(`Duplicate seed zone code "${zone.code}"`);
    zoneCodes.add(zone.code);
  }

  const stopCodes = new Set();
  for (const stop of seedStops) {
    if (stopCodes.has(stop.code)) throw new Error(`Duplicate seed stop code "${stop.code}"`);
    if (!zoneCodes.has(stop.zoneCode)) {
      throw new Error(`Seed stop "${stop.code}" references unknown seed zone "${stop.zoneCode}"`);
    }
    stopCodes.add(stop.code);
  }

  const corridorCodes = new Set();
  for (const corridor of seedCorridors) {
    if (corridorCodes.has(corridor.code)) {
      throw new Error(`Duplicate seed corridor code "${corridor.code}"`);
    }
    corridorCodes.add(corridor.code);
  }

  for (const [corridorCode, stopCodesInCorridor] of Object.entries(seedCorridorStops)) {
    if (!corridorCodes.has(corridorCode)) {
      throw new Error(`Seed corridor stops reference unknown corridor "${corridorCode}"`);
    }
    const seen = new Set();
    for (const stopCode of stopCodesInCorridor) {
      if (!stopCodes.has(stopCode)) {
        throw new Error(`Corridor "${corridorCode}" references unknown stop "${stopCode}"`);
      }
      if (seen.has(stopCode)) {
        throw new Error(`Corridor "${corridorCode}" lists stop "${stopCode}" more than once`);
      }
      seen.add(stopCode);
    }
  }

  const pairs = new Set();
  for (const { fromStopCode, toStopCode } of seedTravelEstimates) {
    if (!stopCodes.has(fromStopCode)) {
      throw new Error(`Seed travel estimate references unknown stop "${fromStopCode}"`);
    }
    if (!stopCodes.has(toStopCode)) {
      throw new Error(`Seed travel estimate references unknown stop "${toStopCode}"`);
    }
    if (fromStopCode === toStopCode) {
      throw new Error(`Seed travel estimate must not start and end at "${fromStopCode}"`);
    }
    const pair = `${fromStopCode}->${toStopCode}`;
    if (pairs.has(pair)) throw new Error(`Duplicate seed travel estimate "${pair}"`);
    pairs.add(pair);
  }
};

const upsertZone = async (client, { code, name, active = true }) => {
  const { rows } = await client.query(
    `INSERT INTO zones (code, name, active)
     VALUES ($1, $2, $3)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active
     RETURNING id`,
    [code, name, active],
  );
  return rows[0].id;
};

const upsertStop = async (client, stop, zoneId) => {
  const { rows } = await client.query(
    `INSERT INTO stops (zone_id, code, name, latitude, longitude, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (code) DO UPDATE
       SET zone_id = EXCLUDED.zone_id,
           name = EXCLUDED.name,
           latitude = EXCLUDED.latitude,
           longitude = EXCLUDED.longitude,
           active = EXCLUDED.active
     RETURNING id`,
    [zoneId, stop.code, stop.name, stop.latitude ?? null, stop.longitude ?? null, stop.active ?? true],
  );
  return rows[0].id;
};

const upsertCorridor = async (client, { code, name, active = true }) => {
  const { rows } = await client.query(
    `INSERT INTO corridors (code, name, active)
     VALUES ($1, $2, $3)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active
     RETURNING id`,
    [code, name, active],
  );
  return rows[0].id;
};

/**
 * Rewrites one corridor's ordered stop list.
 *
 * Two-phase update so that reordering entries in the data file cannot collide
 * with the `(corridor_id, position)` unique constraint mid-transaction:
 *   1. park the current rows well above every seeded position;
 *   2. upsert each seeded stop into its target position, matched by
 *      (corridor_id, stop_id);
 *   3. prune parked rows that the data file no longer lists.
 *
 * Only rows belonging to this seeded corridor are touched.
 */
const upsertCorridorStops = async (client, corridorId, corridorCode, stopCodes, stopIds) => {
  await client.query(`UPDATE corridor_stops SET position = position + $2 WHERE corridor_id = $1`, [
    corridorId,
    PARKING_OFFSET,
  ]);

  let position = 0;
  for (const stopCode of stopCodes) {
    position += 1;
    const stopId = stopIds.get(stopCode);
    if (!stopId) throw new Error(`Corridor "${corridorCode}" references unknown stop "${stopCode}"`);

    await client.query(
      `INSERT INTO corridor_stops (corridor_id, stop_id, position)
       VALUES ($1, $2, $3)
       ON CONFLICT (corridor_id, stop_id) DO UPDATE SET position = EXCLUDED.position`,
      [corridorId, stopId, position],
    );
  }

  await client.query(
    `DELETE FROM corridor_stops WHERE corridor_id = $1 AND position > $2`,
    [corridorId, PARKING_OFFSET],
  );

  return position;
};

const upsertTravelEstimate = async (client, estimate, stopIds) => {
  const fromStopId = stopIds.get(estimate.fromStopCode);
  const toStopId = stopIds.get(estimate.toStopCode);

  await client.query(
    `INSERT INTO travel_estimates
       (from_stop_id, to_stop_id, estimated_minutes, estimated_distance_km, base_fare, currency)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (from_stop_id, to_stop_id) DO UPDATE
       SET estimated_minutes = EXCLUDED.estimated_minutes,
           estimated_distance_km = EXCLUDED.estimated_distance_km,
           base_fare = EXCLUDED.base_fare,
           currency = EXCLUDED.currency`,
    [
      fromStopId,
      toStopId,
      estimate.estimatedMinutes,
      estimate.estimatedDistanceKm,
      estimate.baseFare,
      estimate.currency ?? 'BDT',
    ],
  );
};

/**
 * Applies the transport seed data with the given client.
 * Returns a small summary that is handy for CLI output and tests.
 */
export const seedTransportNetwork = async (client) => {
  assertSeedDataIsCoherent();

  const zoneIds = new Map();
  for (const zone of seedZones) zoneIds.set(zone.code, await upsertZone(client, zone));

  const stopIds = new Map();
  for (const stop of seedStops) {
    stopIds.set(stop.code, await upsertStop(client, stop, zoneIds.get(stop.zoneCode)));
  }

  const corridorIds = new Map();
  for (const corridor of seedCorridors) {
    corridorIds.set(corridor.code, await upsertCorridor(client, corridor));
  }

  let corridorStopCount = 0;
  for (const [corridorCode, stopCodes] of Object.entries(seedCorridorStops)) {
    corridorStopCount += await upsertCorridorStops(
      client,
      corridorIds.get(corridorCode),
      corridorCode,
      stopCodes,
      stopIds,
    );
  }

  for (const estimate of seedTravelEstimates) {
    await upsertTravelEstimate(client, estimate, stopIds);
  }

  return {
    zones: zoneIds.size,
    stops: stopIds.size,
    corridors: corridorIds.size,
    corridorStops: corridorStopCount,
    travelEstimates: seedTravelEstimates.length,
  };
};
