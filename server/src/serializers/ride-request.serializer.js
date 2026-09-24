import { formatMoney } from '../services/fare.calculator.js';
import { isCancellable } from '../services/ride.status.js';
import { quoteRoundingScale } from './fare.serializer.js';

/**
 * The passenger's view of a ride request.
 *
 * A whitelist, like every other serializer here. What it deliberately never
 * contains:
 *
 *   * `requestFingerprint` -- an internal idempotency detail with no meaning to
 *     a client, and one a client could otherwise try to influence;
 *   * any other passenger, and any identifier that could address one;
 *   * the row lock, the raw quote, the route snapshot, or any pricing rate --
 *     the accepted values are summarised, not dumped;
 *   * event internals: history is recorded for audit, and this milestone has no
 *     endpoint that exposes it.
 *
 * The accepted money is a frozen copy made at request time, so it cannot drift:
 * the format is the quote's own (see `quoteRoundingScale`), because the accepted
 * fare is exactly that amount.
 */

const toIsoString = (value) => (value ? new Date(value).toISOString() : null);

/**
 * `cancellable` is derived, never stored: it is true exactly while the request
 * is WAITING, which is also the only status the cancellation operation accepts.
 */
export const toRideRequestDto = (request) => {
  const scale = quoteRoundingScale(request.fareQuote);

  return {
    id: request.id,
    status: request.status,
    cancellable: isCancellable(request.status),
    pickup: {
      code: request.pickupServicePoint.code,
      name: request.pickupServicePoint.name,
    },
    destination: {
      code: request.dropoffServicePoint.code,
      name: request.dropoffServicePoint.name,
    },
    acceptedQuote: {
      fareQuoteId: request.fareQuoteId,
      fare: formatMoney(request.acceptedFare, scale),
      currency: request.currency,
      pricingCode: request.acceptedPricingCode,
      pricingVersion: request.acceptedPricingVersion,
      distanceMeters: request.acceptedDistanceMeters,
      durationSeconds: request.acceptedDurationSeconds,
    },
    requestedAt: toIsoString(request.requestedAt),
    searchExpiresAt: toIsoString(request.searchExpiresAt),
    cancelledAt: toIsoString(request.cancelledAt),
    cancellationReason: request.cancellationReason ?? null,
  };
};

/**
 * The passenger's history page.
 *
 * `data` matches the shape of the other list endpoints; `pagination` is added so
 * a client can page without guessing how many rows exist.
 */
export const toRideRequestListDto = ({ requests, total, limit, offset }) => ({
  data: requests.map(toRideRequestDto),
  pagination: {
    limit,
    offset,
    returned: requests.length,
    total,
    hasMore: offset + requests.length < total,
  },
});
