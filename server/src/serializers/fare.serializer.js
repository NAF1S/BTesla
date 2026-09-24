import {
  DEFAULT_ROUNDING_SCALE,
  formatKilometers,
  formatMinutes,
  formatMoney,
  formatMultiplier,
  MAX_ROUNDING_SCALE,
} from '../services/fare.calculator.js';

/**
 * Response DTO for a stored fare quote.
 *
 * A whitelist, like every other serializer here: every field is copied
 * explicitly, so a column added to fare_quotes later cannot leak by accident.
 *
 * Money is returned as decimal **strings** ("166.28"), not numbers. That is the
 * project's money format -- there is no other -- and it is the only way to hand
 * back an exact decimal: `JSON.parse` of a bare `166.28` produces a binary float,
 * and the paisa would be gone. A client that needs to compare or add these
 * values should parse them as decimals, not as floats.
 *
 * There are no pooled fares, no discounts and no passenger identity here, and no
 * route geometry either: the geometry belongs to `/routes/estimate`, and a quote
 * stores its snapshot for audit rather than replaying the whole route drawing.
 */

const toIsoString = (value) => new Date(value).toISOString();

/**
 * The number of decimals to present money with.
 *
 * Read back from the quote's own stored breakdown rather than from the current
 * policy: the quote records the rounding rule it was produced under, and that is
 * the rule that reproduces its numbers. Anything unexpected falls back to two
 * decimals rather than throwing -- a quote that exists should still be returnable.
 *
 * Exported because anything that holds a copy of a quote's amount -- a ride
 * request's accepted fare, for instance -- has to present it at the same scale.
 */
export const quoteRoundingScale = (quote) => {
  const scale = quote?.fareBreakdown?.rounding?.scale;
  return Number.isInteger(scale) && scale >= 0 && scale <= MAX_ROUNDING_SCALE
    ? scale
    : DEFAULT_ROUNDING_SCALE;
};

export const toFareQuoteDto = ({ quote, origin, destination }) => {
  const scale = quoteRoundingScale(quote);

  return {
    quoteId: quote.id,
    origin: {
      code: origin.code,
      name: origin.name,
    },
    destination: {
      code: destination.code,
      name: destination.name,
    },
    departureAt: toIsoString(quote.departureAt),
    estimatedArrivalAt: toIsoString(quote.estimatedArrivalAt),
    trafficProfile: quote.trafficProfile,
    route: {
      distanceMeters: quote.distanceMeters,
      distanceKilometers: formatKilometers(quote.distanceMeters),
      durationSeconds: quote.durationSeconds,
      durationMinutes: formatMinutes(quote.durationSeconds),
    },
    fare: {
      currency: quote.currency,
      pricingCode: quote.pricingCode,
      pricingVersion: quote.pricingVersion,
      baseFare: formatMoney(quote.baseFare, scale),
      distanceFare: formatMoney(quote.distanceFare, scale),
      timeFare: formatMoney(quote.timeFare, scale),
      preTrafficSubtotal: formatMoney(quote.preTrafficSubtotal, scale),
      trafficMultiplier: formatMultiplier(quote.trafficMultiplier, scale),
      trafficAdjustment: formatMoney(quote.trafficAdjustment, scale),
      minimumFareApplied: quote.minimumFareApplied,
      finalFare: formatMoney(quote.finalFare, scale),
    },
    expiresAt: toIsoString(quote.expiresAt),
  };
};
