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
 * Call it with a Prisma transaction client, e.g.
 *   prisma.$transaction((tx) => seedTransportNetwork(tx))
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

const upsertZone = async (tx, { code, name, active = true }) => {
  const { id } = await tx.zone.upsert({
    where: { code },
    update: { name, active },
    create: { code, name, active },
    select: { id: true },
  });
  return id;
};

const upsertStop = async (tx, stop, zoneId) => {
  const attributes = {
    zoneId,
    name: stop.name,
    latitude: stop.latitude ?? null,
    longitude: stop.longitude ?? null,
    active: stop.active ?? true,
  };

  const { id } = await tx.stop.upsert({
    where: { code: stop.code },
    update: attributes,
    create: { code: stop.code, ...attributes },
    select: { id: true },
  });
  return id;
};

const upsertCorridor = async (tx, { code, name, active = true }) => {
  const { id } = await tx.corridor.upsert({
    where: { code },
    update: { name, active },
    create: { code, name, active },
    select: { id: true },
  });
  return id;
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
const upsertCorridorStops = async (tx, corridorId, corridorCode, stopCodes, stopIds) => {
  await tx.corridorStop.updateMany({
    where: { corridorId },
    data: { position: { increment: PARKING_OFFSET } },
  });

  let position = 0;
  for (const stopCode of stopCodes) {
    position += 1;
    const stopId = stopIds.get(stopCode);
    if (!stopId) throw new Error(`Corridor "${corridorCode}" references unknown stop "${stopCode}"`);

    await tx.corridorStop.upsert({
      where: { corridorId_stopId: { corridorId, stopId } },
      update: { position },
      create: { corridorId, stopId, position },
    });
  }

  await tx.corridorStop.deleteMany({
    where: { corridorId, position: { gt: PARKING_OFFSET } },
  });

  return position;
};

const upsertTravelEstimate = async (tx, estimate, stopIds) => {
  const fromStopId = stopIds.get(estimate.fromStopCode);
  const toStopId = stopIds.get(estimate.toStopCode);

  const attributes = {
    estimatedMinutes: estimate.estimatedMinutes,
    estimatedDistanceKm: estimate.estimatedDistanceKm,
    baseFare: estimate.baseFare,
    currency: estimate.currency ?? 'BDT',
  };

  await tx.travelEstimate.upsert({
    // Directional by construction: the key is the ordered (from, to) pair.
    where: { fromStopId_toStopId: { fromStopId, toStopId } },
    update: attributes,
    create: { fromStopId, toStopId, ...attributes },
  });
};

/**
 * Applies the transport seed data with the given transaction client.
 * Returns a small summary that is handy for CLI output and tests.
 */
export const seedTransportNetwork = async (tx) => {
  assertSeedDataIsCoherent();

  const zoneIds = new Map();
  for (const zone of seedZones) zoneIds.set(zone.code, await upsertZone(tx, zone));

  const stopIds = new Map();
  for (const stop of seedStops) {
    stopIds.set(stop.code, await upsertStop(tx, stop, zoneIds.get(stop.zoneCode)));
  }

  const corridorIds = new Map();
  for (const corridor of seedCorridors) {
    corridorIds.set(corridor.code, await upsertCorridor(tx, corridor));
  }

  let corridorStopCount = 0;
  for (const [corridorCode, stopCodes] of Object.entries(seedCorridorStops)) {
    corridorStopCount += await upsertCorridorStops(
      tx,
      corridorIds.get(corridorCode),
      corridorCode,
      stopCodes,
      stopIds,
    );
  }

  for (const estimate of seedTravelEstimates) {
    await upsertTravelEstimate(tx, estimate, stopIds);
  }

  return {
    zones: zoneIds.size,
    stops: stopIds.size,
    corridors: corridorIds.size,
    corridorStops: corridorStopCount,
    travelEstimates: seedTravelEstimates.length,
  };
};
