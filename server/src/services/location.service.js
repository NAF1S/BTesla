import { prisma } from '../db/prisma.js';

/**
 * Read-only queries for the location foundation.
 *
 * The coordinates live in PostGIS columns, which Prisma models as
 * `Unsupported`, so they cannot be selected through the Prisma client. These
 * queries therefore use parameterised raw SQL and project each geometry back
 * into a plain number with ST_Y (latitude) and ST_X (longitude) -- the exact
 * reverse of the order used to store them.
 *
 * Nothing here computes routes, distances or fares. That is a later phase.
 */

const POINT_COLUMNS = `
  p.id,
  p.code,
  p.name,
  z.code AS zone_code,
  ST_Y(p.location::geometry) AS latitude,
  ST_X(p.location::geometry) AS longitude
`;

export const findActiveZones = () =>
  prisma.$queryRawUnsafe(
    `SELECT z.id,
            z.code,
            z.name,
            ST_Y(z.center_location::geometry) AS latitude,
            ST_X(z.center_location::geometry) AS longitude
       FROM service_zones z
      WHERE z.active
      ORDER BY z.name, z.code`,
  );

/** Returns inactive zones too, so the caller can answer 409 rather than 404. */
export const findZoneByCode = async (code) => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT z.id, z.code, z.name, z.active FROM service_zones z WHERE z.code = $1`,
    code,
  );
  return rows[0] ?? null;
};

/** Active points, optionally narrowed to one zone code. */
export const findActivePoints = ({ zoneCode = null } = {}) =>
  prisma.$queryRawUnsafe(
    `SELECT ${POINT_COLUMNS}
       FROM service_points p
       JOIN service_zones z ON z.id = p.zone_id
      WHERE p.active
        AND ($1::text IS NULL OR z.code = $1::text)
      ORDER BY z.name, p.name, p.code`,
    zoneCode,
  );

/**
 * A single point by code. Returns inactive points too, so the caller can answer
 * 409 ("exists but is switched off") instead of 404.
 */
export const findPointByCode = async (code) => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.active, ${POINT_COLUMNS}
       FROM service_points p
       JOIN service_zones z ON z.id = p.zone_id
      WHERE p.code = $1`,
    code,
  );
  return rows[0] ?? null;
};
