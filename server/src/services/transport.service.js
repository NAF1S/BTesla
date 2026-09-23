import { prisma } from '../db/prisma.js';

/**
 * Read-only queries for the transport network (zones, stops, corridors and
 * directional travel estimates).
 *
 * Conventions follow services/user.service.js: Prisma results are returned
 * as-is, HTTP status decisions are left to the controller, and
 * serializers/transport.serializer.js turns them into DTOs so no raw record
 * ever reaches the client.
 */

const STOP_SELECT = {
  id: true,
  code: true,
  name: true,
  latitude: true,
  longitude: true,
  active: true,
  zone: { select: { code: true } },
};

export const findActiveZones = () =>
  prisma.zone.findMany({
    where: { active: true },
    select: { id: true, code: true, name: true },
    orderBy: [{ name: 'asc' }, { code: 'asc' }],
  });

export const findZoneByCode = (code) =>
  prisma.zone.findUnique({
    where: { code },
    select: { id: true, code: true, name: true, active: true },
  });

/**
 * Active stops, optionally narrowed to one zone code.
 * Pass `zoneCode: null` for every active stop.
 */
export const findActiveStops = ({ zoneCode = null } = {}) =>
  prisma.stop.findMany({
    where: { active: true, ...(zoneCode ? { zone: { code: zoneCode } } : {}) },
    select: STOP_SELECT,
    orderBy: [{ zone: { name: 'asc' } }, { name: 'asc' }, { code: 'asc' }],
  });

/**
 * A single stop by code. Returns the record even when it is inactive so the
 * caller can answer 409 ("exists but is switched off") instead of 404.
 */
export const findStopByCode = (code) =>
  prisma.stop.findUnique({
    where: { code },
    select: STOP_SELECT,
  });

export const findActiveCorridors = () =>
  prisma.corridor.findMany({
    where: { active: true },
    select: { id: true, code: true, name: true, active: true },
    orderBy: [{ name: 'asc' }, { code: 'asc' }],
  });

/** A single corridor by code; inactive corridors are returned so the caller can answer 409. */
export const findCorridorByCode = (code) =>
  prisma.corridor.findUnique({
    where: { code },
    select: { id: true, code: true, name: true, active: true },
  });

/**
 * The ordered stop list of a corridor. Inactive stops are omitted from reads,
 * matching the "reject inactive stops" rule of the rest of the feature; the
 * remaining positions keep their stored values so the order stays unambiguous.
 */
export const findCorridorStops = (corridorId) =>
  prisma.corridorStop.findMany({
    where: { corridorId, stop: { active: true } },
    select: { position: true, stop: { select: STOP_SELECT } },
    orderBy: { position: 'asc' },
  });

/**
 * Active corridors that contain both stops with the pickup strictly before the
 * drop-off. Direction matters: a one-way corridor never matches the reversed
 * pair, because the comparison is made on corridor positions, not on codes.
 *
 * One query fetches the membership rows for both stops; pairing them per
 * corridor and applying the position comparison is then pure in-memory work.
 */
export const findCorridorsForStopPair = async (pickupStopId, dropoffStopId) => {
  const memberships = await prisma.corridorStop.findMany({
    where: {
      stopId: { in: [pickupStopId, dropoffStopId] },
      corridor: { active: true },
    },
    select: {
      corridorId: true,
      stopId: true,
      position: true,
      corridor: { select: { id: true, code: true, name: true } },
    },
  });

  const matches = new Map();
  for (const row of memberships) {
    const entry = matches.get(row.corridorId) ?? {
      corridor: row.corridor,
      pickupPosition: null,
      dropoffPosition: null,
    };
    if (row.stopId === pickupStopId) entry.pickupPosition = row.position;
    if (row.stopId === dropoffStopId) entry.dropoffPosition = row.position;
    matches.set(row.corridorId, entry);
  }

  return [...matches.values()]
    .filter(
      ({ pickupPosition, dropoffPosition }) =>
        pickupPosition !== null && dropoffPosition !== null && pickupPosition < dropoffPosition,
    )
    .sort(
      (a, b) =>
        a.corridor.name.localeCompare(b.corridor.name) ||
        a.corridor.code.localeCompare(b.corridor.code),
    );
};

/**
 * The direct estimate from one stop to another.
 *
 * Travel estimates are directional: there is deliberately no fallback that
 * looks up the reverse pair, so A -> B is not answered by a B -> A record.
 */
export const findTravelEstimate = (fromStopId, toStopId) =>
  prisma.travelEstimate.findUnique({
    where: { fromStopId_toStopId: { fromStopId, toStopId } },
    select: {
      estimatedMinutes: true,
      estimatedDistanceKm: true,
      baseFare: true,
      currency: true,
      fromStop: { select: { code: true, name: true } },
      toStop: { select: { code: true, name: true } },
    },
  });
