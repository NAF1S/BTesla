import * as routing from '../services/routing.service.js';
import * as dto from '../serializers/route.serializer.js';
import { assertBodyKeys, optionalIsoTimestamp, requireCode } from '../utils/validation.js';

/**
 * Route estimate endpoint.
 *
 * Requires authentication (see routes/route.routes.js). The caller's identity is
 * not needed to answer the question -- the graph is public knowledge and nothing
 * is written -- so `req.user` is not read here; the guard is an access-control
 * boundary, not an input to the calculation.
 *
 * The endpoint is a pure read of the stored graph: it calculates a path, its
 * distance and its duration, and writes nothing. There is no fare, no ride
 * request, no pool and no matching here, and none should be added in this phase.
 *
 * Status-code convention, shared with the location endpoints:
 *   400 - malformed request (bad code, bad timestamp, origin === destination)
 *   401 - no valid authentication
 *   404 - unknown ServicePoint code
 *   409 - the point exists but is inactive, or its routing vertex is
 *   422 - no route exists between two valid, active points
 *   500 - the graph or pgRouting failed; never a raw SQL or driver message
 *
 * Nothing client-supplied reaches the SQL: the two ServicePoint codes are
 * validated codes used as bind parameters, the departure time is parsed into an
 * instant, and the traffic profile is derived on the server from fixed windows.
 * A client cannot choose a profile, a graph identifier, an edge filter or a cost
 * expression.
 */

const ESTIMATE_BODY_KEYS = [
  'originServicePointCode',
  'destinationServicePointCode',
  'departureAt',
];

export const estimateRoute = async (req, res) => {
  assertBodyKeys(req.body, ESTIMATE_BODY_KEYS);

  const originServicePointCode = requireCode(
    req.body.originServicePointCode,
    'originServicePointCode',
  );
  const destinationServicePointCode = requireCode(
    req.body.destinationServicePointCode,
    'destinationServicePointCode',
  );
  // An omitted departureAt means "leave now". It is only ever used to pick a
  // traffic profile in Asia/Dhaka; the value returned is always UTC.
  const departureAt = optionalIsoTimestamp(req.body.departureAt, 'departureAt') ?? new Date();

  const estimate = await routing.estimateRoute({
    originServicePointCode,
    destinationServicePointCode,
    departureAt,
  });

  res.json(dto.toRouteEstimateDto(estimate));
};
