import * as transport from '../services/transport.service.js';
import * as dto from '../serializers/transport.serializer.js';
import { ApiError } from '../utils/ApiError.js';
import { assertQueryKeys, optionalCode, requireCode } from '../utils/validation.js';

/**
 * Read-only transport-network endpoints.
 *
 * Status-code convention shared by every handler here (Express 5 forwards
 * rejected promises to middleware/errorHandler.js automatically):
 *   400 - invalid or unsupported query parameter
 *   404 - unknown code
 *   409 - the record exists but is inactive (a state conflict, not a typo)
 * Database-level unique/foreign-key conflicts are mapped to 409 by
 * errorHandler.js for the same reason.
 */

const STOPS_QUERY_KEYS = ['zoneCode'];
const MATCH_QUERY_KEYS = ['pickupStopCode', 'dropoffStopCode'];
const ESTIMATE_QUERY_KEYS = ['fromStopCode', 'toStopCode'];

/** Resolves a code to an active stop, or throws the matching 404/409. */
const resolveActiveStop = async (code, field) => {
  const stop = await transport.findStopByCode(code);
  if (!stop) throw new ApiError(404, `${field} "${code}" was not found`);
  if (!stop.active) throw new ApiError(409, `${field} "${code}" is inactive`);
  return stop;
};

export const listZones = async (_req, res) => {
  const zones = await transport.findActiveZones();
  res.json({ data: zones.map(dto.toZoneDto) });
};

export const listStops = async (req, res) => {
  assertQueryKeys(req.query, STOPS_QUERY_KEYS);
  const zoneCode = optionalCode(req.query.zoneCode, 'zoneCode');

  if (zoneCode) {
    const zone = await transport.findZoneByCode(zoneCode);
    if (!zone) throw new ApiError(404, `zoneCode "${zoneCode}" was not found`);
    if (!zone.active) throw new ApiError(409, `zoneCode "${zoneCode}" is inactive`);
  }

  const stops = await transport.findActiveStops({ zoneCode });
  res.json({ data: stops.map(dto.toStopDto) });
};

export const getStop = async (req, res) => {
  const code = requireCode(req.params.code, 'code');
  const stop = await resolveActiveStop(code, 'Stop');
  res.json({ data: dto.toStopDto(stop) });
};

export const listCorridors = async (_req, res) => {
  const corridors = await transport.findActiveCorridors();
  res.json({ data: corridors.map(dto.toCorridorDto) });
};

export const getCorridor = async (req, res) => {
  const code = requireCode(req.params.code, 'code');

  const corridor = await transport.findCorridorByCode(code);
  if (!corridor) throw new ApiError(404, `Corridor "${code}" was not found`);
  if (!corridor.active) throw new ApiError(409, `Corridor "${code}" is inactive`);

  const stops = await transport.findCorridorStops(corridor.id);
  res.json({ data: dto.toCorridorDetailDto(corridor, stops) });
};

export const matchCorridors = async (req, res) => {
  assertQueryKeys(req.query, MATCH_QUERY_KEYS);
  const pickupCode = requireCode(req.query.pickupStopCode, 'pickupStopCode');
  const dropoffCode = requireCode(req.query.dropoffStopCode, 'dropoffStopCode');
  if (pickupCode === dropoffCode) {
    throw new ApiError(400, 'pickupStopCode and dropoffStopCode must be different stops');
  }

  const pickup = await resolveActiveStop(pickupCode, 'pickupStopCode');
  const dropoff = await resolveActiveStop(dropoffCode, 'dropoffStopCode');

  const matches = await transport.findCorridorsForStopPair(pickup.id, dropoff.id);
  res.json({ data: matches.map(dto.toCorridorMatchDto) });
};

export const getTravelEstimate = async (req, res) => {
  assertQueryKeys(req.query, ESTIMATE_QUERY_KEYS);
  const fromCode = requireCode(req.query.fromStopCode, 'fromStopCode');
  const toCode = requireCode(req.query.toStopCode, 'toStopCode');
  if (fromCode === toCode) {
    throw new ApiError(400, 'fromStopCode and toStopCode must be different stops');
  }

  const from = await resolveActiveStop(fromCode, 'fromStopCode');
  const to = await resolveActiveStop(toCode, 'toStopCode');

  const estimate = await transport.findTravelEstimate(from.id, to.id);
  if (!estimate) {
    // Deliberately directional: no reverse lookup is attempted.
    throw new ApiError(404, `No travel estimate from "${fromCode}" to "${toCode}"`);
  }

  res.json({ data: dto.toTravelEstimateDto(estimate) });
};
