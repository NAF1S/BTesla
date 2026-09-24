import * as fare from '../services/fare.service.js';
import * as dto from '../serializers/fare.serializer.js';
import { assertBodyKeys, optionalIsoTimestamp, requireCode } from '../utils/validation.js';

/**
 * Fare quote endpoint.
 *
 * Requires authentication (see routes/fare.routes.js). The caller's identity is
 * not an input: nothing about the quote depends on who asked, no ownership is
 * recorded in this phase, and `req.user` is deliberately not read here.
 *
 * The body is exactly the one `/routes/estimate` accepts, and for the same
 * reason: everything a fare is computed from -- distance, duration, edge fare
 * weights, traffic profile, policy version -- comes from the server. The only
 * accepted fields are the two service point codes and an optional departure
 * instant, and `assertBodyKeys` turns any attempt to send `distanceMeters`,
 * `finalFare`, `pricingVersion` or similar into a 400 instead of a silent
 * no-op.
 *
 * Status-code convention:
 *   201 - a quote was created and stored
 *   400 - malformed request (bad code, bad timestamp, identical endpoints,
 *         unsupported body field)
 *   401 - no valid authentication
 *   404 - unknown ServicePoint code
 *   409 - the point exists but is inactive, or its routing vertex is
 *   422 - no route exists between two valid, active points
 *   500 - the graph, the routing algorithm, the pricing configuration or the
 *         quote write failed; never a raw SQL or driver message
 */

const QUOTE_BODY_KEYS = [
  'originServicePointCode',
  'destinationServicePointCode',
  'departureAt',
];

export const createFareQuote = async (req, res) => {
  assertBodyKeys(req.body, QUOTE_BODY_KEYS);

  const originServicePointCode = requireCode(
    req.body.originServicePointCode,
    'originServicePointCode',
  );
  const destinationServicePointCode = requireCode(
    req.body.destinationServicePointCode,
    'destinationServicePointCode',
  );
  // Omitted means "leave now". It decides both the route's traffic profile and
  // which pricing policy version is in force.
  const departureAt = optionalIsoTimestamp(req.body.departureAt, 'departureAt') ?? new Date();

  const quote = await fare.createSoloFareQuote({
    originServicePointCode,
    destinationServicePointCode,
    departureAt,
  });

  // 201: a quote is a stored resource with an id, like a created account.
  res.status(201).json(dto.toFareQuoteDto(quote));
};
