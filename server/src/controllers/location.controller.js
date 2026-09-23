import { ApiError } from '../utils/ApiError.js';
import * as location from '../services/location.service.js';
import * as dto from '../serializers/location.serializer.js';
import { assertQueryKeys, optionalCode, requireCode } from '../utils/validation.js';

/**
 * Read-only location endpoints.
 *
 * These replaced the earlier transport-network reads. The surface is
 * deliberately limited to the four reads the location foundation supports --
 * listing zones, listing points, filtering points by zone, and fetching one
 * point by code. There is no route, distance, fare, ride or matching endpoint
 * here, and none should be added in this phase.
 *
 * Status-code convention, shared with the rest of the API:
 *   400 - invalid or unsupported query parameter
 *   404 - unknown code
 *   409 - the record exists but is inactive (a state conflict, not a typo)
 */

const POINTS_QUERY_KEYS = ['zoneCode'];

/** Resolves a code to an active point, or throws the matching 404/409. */
const resolveActivePoint = async (code) => {
  const point = await location.findPointByCode(code);
  if (!point) throw new ApiError(404, `Service point "${code}" was not found`);
  if (!point.active) throw new ApiError(409, `Service point "${code}" is inactive`);
  return point;
};

export const listZones = async (_req, res) => {
  const zones = await location.findActiveZones();
  res.json({ data: zones.map(dto.toZoneDto) });
};

export const listPoints = async (req, res) => {
  assertQueryKeys(req.query, POINTS_QUERY_KEYS);
  const zoneCode = optionalCode(req.query.zoneCode, 'zoneCode');

  if (zoneCode) {
    const zone = await location.findZoneByCode(zoneCode);
    if (!zone) throw new ApiError(404, `zoneCode "${zoneCode}" was not found`);
    if (!zone.active) throw new ApiError(409, `zoneCode "${zoneCode}" is inactive`);
  }

  const points = await location.findActivePoints({ zoneCode });
  res.json({ data: points.map(dto.toPointDto) });
};

export const getPoint = async (req, res) => {
  const code = requireCode(req.params.code, 'code');
  const point = await resolveActivePoint(code);
  res.json({ data: dto.toPointDto(point) });
};
