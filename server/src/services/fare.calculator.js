import { Prisma } from '@prisma/client';

/**
 * Solo-fare calculation, as pure functions.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE HAS NO DATABASE IN IT
 * ---------------------------------------------------------------------------
 * The fare formula is the part of pricing that must be provable. It takes a
 * policy, the traversed route legs and the route totals, and returns every
 * component of the price -- no queries, no clock, no HTTP. src/services/fare.service.js
 * does the loading and persistence around it, and the unit tests call straight
 * into here.
 *
 * ---------------------------------------------------------------------------
 * MONEY IS EXACT DECIMAL, NEVER A JAVASCRIPT NUMBER
 * ---------------------------------------------------------------------------
 * Every monetary value and every fare weight flows through decimal.js (which
 * Prisma re-exports as `Prisma.Decimal`, so no extra dependency is involved).
 * A `number` is refused outright by `toExactDecimal`: binary floating point
 * cannot hold 0.10, and `0.1 + 0.2 !== 0.3`, so a fare computed from one is a
 * fare that cannot be reproduced. Rates are accepted as decimal strings or
 * Decimal objects, which is exactly what the database returns for a `numeric`
 * column and exactly what the seed file contains.
 *
 * Division (metres -> kilometres, seconds -> minutes) is performed at decimal.js's
 * default precision of 20 significant digits, far beyond the few decimals a fare
 * is ever presented with, and it is deterministic: the same inputs always
 * produce the same output.
 *
 * ---------------------------------------------------------------------------
 * THE FORMULA, AND WHERE IT ROUNDS
 * ---------------------------------------------------------------------------
 *     edgeDistanceKilometers = edgeDistanceMeters / 1000
 *     edgeDistanceCharge     = edgeDistanceKilometers × perKilometerRate × edgeFareWeight   [rounded]
 *
 *     distanceFare           = sum(edgeDistanceCharge)
 *     timeFare               = (durationSeconds / 60) × perMinuteRate                       [rounded]
 *     preTrafficSubtotal     = baseFare + distanceFare + timeFare
 *     trafficMultiplier      = rushHourMultiplier | normalTrafficMultiplier
 *     trafficAdjustment      = preTrafficSubtotal × (trafficMultiplier - 1)                 [rounded]
 *     trafficAdjustedFare    = preTrafficSubtotal + trafficAdjustment
 *     finalFare              = max(minimumFare, trafficAdjustedFare)
 *
 * Rounding is **HALF_UP to `roundingScale` decimals**, and it happens at exactly
 * two kinds of boundary, both marked [rounded] above:
 *
 *   1. when a money figure is produced (each edge's distance charge, the time
 *      fare, and the traffic adjustment);
 *   2. when a configured *amount* enters the calculation (baseFare, minimumFare
 *      are expressed at `roundingScale`).
 *
 * Nothing else is rounded, and no figure is rounded twice. Rates are *not*
 * rounded: a rate is a price per unit, not an amount, so it keeps the precision
 * it was configured with.
 *
 * The consequence is the property that makes a stored quote auditable: every
 * figure is an amount at `roundingScale`, so the stored components add up
 * exactly -- `distanceFare` is literally the sum of the per-edge charges in the
 * snapshot, `preTrafficSubtotal` is literally the sum of the three components,
 * and `finalFare` is literally the subtotal plus the traffic adjustment (or the
 * minimum fare). The database enforces the last two with CHECK constraints.
 *
 * The traffic multiplier is applied **once**, as `subtotal + adjustment`, never
 * as `subtotal × multiplier` after some other adjustment. `normalTrafficMultiplier`
 * defaults to 1.00 in the seed precisely so that off-peak quoting is the
 * baseline rather than a hidden second adjustment.
 */

const { Decimal } = Prisma;

/** The rounding rule applied to every money figure. Stored on the quote. */
export const MONEY_ROUNDING_MODE = 'HALF_UP';
const ROUNDING_MODE = Decimal.ROUND_HALF_UP;

export const METRES_PER_KILOMETER = 1000;
export const SECONDS_PER_MINUTE = 60;

/** Presentation precision: kilometres to the metre, minutes to the second. */
export const KILOMETER_PRECISION = 3;
export const MINUTE_PRECISION = 2;

/** A multiplier is never shown with fewer than two decimals ("1.10", not "1.1"). */
export const MULTIPLIER_MINIMUM_PRECISION = 2;

export const DEFAULT_ROUNDING_SCALE = 2;
/** fare_quotes stores numeric(14,6), so 6 decimals is the widest usable scale. */
export const MAX_ROUNDING_SCALE = 6;

/** numeric(14,6) holds up to 99,999,999.999999; anything past this cannot be stored. */
export const MAX_STORABLE_AMOUNT = new Decimal('100000000');

/** The only currency this MVP prices in; the database enforces the same rule. */
export const SUPPORTED_CURRENCY = 'BDT';

const TRAFFIC_PROFILES = ['NORMAL', 'RUSH_HOUR'];
const DIRECTIONS = ['FORWARD', 'BACKWARD'];

/**
 * A calculation that cannot be performed from the data it was given.
 *
 * The service turns this into a controlled 500: it always means the server's own
 * configuration or graph data is wrong, never that the client asked badly. The
 * message is for the server log; the client sees a stable message instead.
 */
export class FareCalculationError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'FareCalculationError';
    this.reason = reason;
  }
}

/**
 * Coerces a value that must be an exact decimal.
 *
 * `number` is refused rather than converted: by the time a money value is a
 * JavaScript number, the precision is already gone.
 */
const toExactDecimal = (value, label) => {
  if (value instanceof Decimal) {
    if (!value.isFinite()) throw new FareCalculationError(`${label} is not a finite decimal`);
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed = new Decimal(value);
      if (!parsed.isFinite()) throw new FareCalculationError(`${label} is not a finite decimal`);
      return parsed;
    } catch (err) {
      if (err instanceof FareCalculationError) throw err;
      throw new FareCalculationError(`${label} is not a decimal: ${JSON.stringify(value)}`);
    }
  }

  if (typeof value === 'number') {
    throw new FareCalculationError(
      `${label} must be a decimal string or Decimal, never a JavaScript number (got ${value})`,
    );
  }

  throw new FareCalculationError(`${label} is missing`);
};

const roundTo = (value, scale) => value.toDecimalPlaces(scale, ROUNDING_MODE);

const requirePositiveInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new FareCalculationError(`${label} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return number;
};

/** Reads and validates everything the calculation needs from a policy row. */
const readPolicy = (policy) => {
  if (!policy) throw new FareCalculationError('no fare policy was supplied');

  const label = `fare policy ${policy.code ?? '?'} v${policy.version ?? '?'}`;

  if (typeof policy.code !== 'string' || policy.code.trim() === '') {
    throw new FareCalculationError(`${label} has no code`);
  }
  const version = requirePositiveInteger(policy.version, `${label} version`);

  if (policy.currency !== SUPPORTED_CURRENCY) {
    throw new FareCalculationError(
      `${label} has an invalid currency: ${JSON.stringify(policy.currency)} ` +
        `(${SUPPORTED_CURRENCY} is the only supported currency)`,
    );
  }

  const scale = Number(policy.roundingScale);
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_ROUNDING_SCALE) {
    throw new FareCalculationError(
      `${label} has an invalid roundingScale: ${JSON.stringify(policy.roundingScale)}`,
    );
  }

  const quoteTtlSeconds = requirePositiveInteger(policy.quoteTtlSeconds, `${label} quoteTtlSeconds`);

  const perKilometerRate = toExactDecimal(policy.perKilometerRate, `${label} perKilometerRate`);
  const perMinuteRate = toExactDecimal(policy.perMinuteRate, `${label} perMinuteRate`);
  const normalTrafficMultiplier = toExactDecimal(
    policy.normalTrafficMultiplier,
    `${label} normalTrafficMultiplier`,
  );
  const rushHourMultiplier = toExactDecimal(policy.rushHourMultiplier, `${label} rushHourMultiplier`);
  const configuredMinimumFare = toExactDecimal(policy.minimumFare, `${label} minimumFare`);
  const configuredBaseFare = toExactDecimal(policy.baseFare, `${label} baseFare`);

  if (perKilometerRate.isNegative() || perMinuteRate.isNegative()) {
    throw new FareCalculationError(`${label} has a negative rate`);
  }
  if (configuredMinimumFare.isNegative() || configuredBaseFare.isNegative()) {
    throw new FareCalculationError(`${label} has a negative amount`);
  }
  if (normalTrafficMultiplier.lte(0) || rushHourMultiplier.lte(0)) {
    throw new FareCalculationError(`${label} has a multiplier that is not positive`);
  }

  return {
    code: policy.code,
    version,
    currency: policy.currency,
    roundingScale: scale,
    quoteTtlSeconds,
    perKilometerRate,
    perMinuteRate,
    normalTrafficMultiplier,
    rushHourMultiplier,
    // Amounts enter the calculation at the policy's own money precision, so
    // every figure in the breakdown is an amount at `roundingScale`.
    baseFare: roundTo(configuredBaseFare, scale),
    minimumFare: roundTo(configuredMinimumFare, scale),
  };
};

/**
 * Reads the traversed legs.
 *
 * A leg without a usable fare weight is a graph-data error, not a default: there
 * is no "assume 1.0" path, because silently pricing an unweighted edge is how a
 * fare quietly becomes wrong.
 */
const readLegs = (legs) => {
  if (!Array.isArray(legs) || legs.length === 0) {
    throw new FareCalculationError('the route has no legs to price');
  }

  return legs.map((leg, index) => {
    const code = typeof leg.edgeCode === 'string' && leg.edgeCode !== '' ? leg.edgeCode : null;
    if (!code) throw new FareCalculationError(`leg ${index + 1} has no edge code`);

    const fareWeight = toExactDecimal(leg.fareWeight, `fare weight of edge "${code}"`);
    if (fareWeight.lte(0)) {
      throw new FareCalculationError(
        `edge "${code}" has a fare weight of ${fareWeight.toString()}, which is not positive`,
      );
    }

    const direction = DIRECTIONS.includes(leg.direction) ? leg.direction : null;
    if (!direction) throw new FareCalculationError(`edge "${code}" has no traversal direction`);

    return {
      // Legs arrive in path order from the routing service; the sequence is the
      // calculator's own record of that order.
      sequence: index + 1,
      edgeCode: code,
      direction,
      distanceMeters: requirePositiveInteger(leg.distanceMeters, `distance of edge "${code}"`),
      durationSeconds: requirePositiveInteger(leg.durationSeconds, `duration of edge "${code}"`),
      fareWeight,
    };
  });
};

const readTrafficProfile = (trafficProfile) => {
  if (!TRAFFIC_PROFILES.includes(trafficProfile)) {
    throw new FareCalculationError(
      `the route traffic profile is ${JSON.stringify(trafficProfile)}, which is not one of ${TRAFFIC_PROFILES.join(', ')}`,
    );
  }
  return trafficProfile;
};

/** Refuses an amount that would not fit the column it has to be stored in. */
const assertStorable = (amounts) => {
  for (const [label, value] of Object.entries(amounts)) {
    if (!value.isFinite()) throw new FareCalculationError(`${label} is not a finite amount`);
    if (value.abs().gte(MAX_STORABLE_AMOUNT)) {
      throw new FareCalculationError(`${label} (${value.toString()}) is too large to store`);
    }
  }
};

export const formatMoney = (value, scale = DEFAULT_ROUNDING_SCALE) =>
  toExactDecimal(value, 'amount').toFixed(scale);

export const formatKilometers = (distanceMeters) =>
  new Decimal(distanceMeters).div(METRES_PER_KILOMETER).toFixed(KILOMETER_PRECISION);

export const formatMinutes = (durationSeconds) =>
  new Decimal(durationSeconds).div(SECONDS_PER_MINUTE).toFixed(MINUTE_PRECISION);

/** Multipliers read as "1.10" rather than "1.1", and never lose their decimals. */
export const formatMultiplier = (value, scale = DEFAULT_ROUNDING_SCALE) =>
  toExactDecimal(value, 'multiplier').toFixed(Math.max(MULTIPLIER_MINIMUM_PRECISION, scale));

/**
 * When a quote created at `createdAt` stops being usable.
 *
 * This is the one definition of quote expiry: `createdAt + quoteTtlSeconds`.
 * Expiry is a deadline, not a deletion -- an expired quote stays stored, and a
 * later RideRequest milestone must refuse to accept one that `isQuoteExpired`.
 */
export const quoteExpiresAt = (createdAt, quoteTtlSeconds) => {
  const ttl = requirePositiveInteger(quoteTtlSeconds, 'quoteTtlSeconds');
  return new Date(new Date(createdAt).getTime() + ttl * 1000);
};

/** True once `expiresAt` has been reached. The boundary instant is expired. */
export const isQuoteExpired = (quote, at = new Date()) =>
  new Date(quote.expiresAt).getTime() <= new Date(at).getTime();

/**
 * Prices one solo journey.
 *
 * All inputs come from the server: the legs and totals from the routing service,
 * the policy from the database. Nothing here can be reached by a client.
 */
export const calculateSoloFare = ({
  policy,
  legs,
  distanceMeters,
  durationSeconds,
  trafficProfile,
}) => {
  const priced = readPolicy(policy);
  const scale = priced.roundingScale;
  const pricedLegs = readLegs(legs);
  const profile = readTrafficProfile(trafficProfile);

  const routeDistanceMeters = requirePositiveInteger(distanceMeters, 'route distance');
  const routeDurationSeconds = requirePositiveInteger(durationSeconds, 'route duration');

  // The route's own totals must be exactly what its legs add up to. If they are
  // not, the authoritative route and the priced legs disagree and any fare would
  // be describing a journey that was never routed.
  const legDistanceMeters = pricedLegs.reduce((total, leg) => total + leg.distanceMeters, 0);
  const legDurationSeconds = pricedLegs.reduce((total, leg) => total + leg.durationSeconds, 0);

  if (legDistanceMeters !== routeDistanceMeters) {
    throw new FareCalculationError(
      `the route reports ${routeDistanceMeters} m but its legs add up to ${legDistanceMeters} m`,
    );
  }
  if (legDurationSeconds !== routeDurationSeconds) {
    throw new FareCalculationError(
      `the route reports ${routeDurationSeconds} s but its legs add up to ${legDurationSeconds} s`,
    );
  }

  const trafficMultiplier =
    profile === 'RUSH_HOUR' ? priced.rushHourMultiplier : priced.normalTrafficMultiplier;

  // 1. Per-edge weighted distance charges. The weight multiplies the distance
  //    charge only -- it never reaches the duration, and it never reaches the
  //    router, which has already chosen this path on duration alone.
  const edges = pricedLegs.map((leg) => {
    const kilometers = new Decimal(leg.distanceMeters).div(METRES_PER_KILOMETER);
    const unroundedCharge = kilometers.times(priced.perKilometerRate).times(leg.fareWeight);

    return { ...leg, kilometers, distanceCharge: roundTo(unroundedCharge, scale) };
  });

  const distanceFare = edges.reduce((total, edge) => total.plus(edge.distanceCharge), new Decimal(0));
  const distanceKilometers = new Decimal(routeDistanceMeters).div(METRES_PER_KILOMETER);

  const durationMinutes = new Decimal(routeDurationSeconds).div(SECONDS_PER_MINUTE);
  const timeFare = roundTo(durationMinutes.times(priced.perMinuteRate), scale);

  const preTrafficSubtotal = priced.baseFare.plus(distanceFare).plus(timeFare);

  // The multiplier is applied exactly once, as a recorded adjustment on top of
  // the subtotal: `subtotal + round(subtotal × (multiplier - 1))`. It is never
  // applied to the subtotal a second time, and never to the final fare.
  const trafficAdjustment = roundTo(
    preTrafficSubtotal.times(trafficMultiplier.minus(1)),
    scale,
  );
  const trafficAdjustedFare = preTrafficSubtotal.plus(trafficAdjustment);

  const minimumFareApplied = priced.minimumFare.greaterThan(trafficAdjustedFare);
  const finalFare = Decimal.max(priced.minimumFare, trafficAdjustedFare);

  assertStorable({
    baseFare: priced.baseFare,
    distanceFare,
    timeFare,
    preTrafficSubtotal,
    trafficAdjustment,
    trafficAdjustedFare,
    minimumFare: priced.minimumFare,
    finalFare,
  });

  return {
    currency: priced.currency,
    pricingCode: priced.code,
    pricingVersion: priced.version,
    roundingScale: scale,
    roundingMode: MONEY_ROUNDING_MODE,
    quoteTtlSeconds: priced.quoteTtlSeconds,
    trafficProfile: profile,

    distanceMeters: routeDistanceMeters,
    distanceKilometers,
    durationSeconds: routeDurationSeconds,
    durationMinutes,

    policy: {
      baseFare: priced.baseFare,
      perKilometerRate: priced.perKilometerRate,
      perMinuteRate: priced.perMinuteRate,
      minimumFare: priced.minimumFare,
      normalTrafficMultiplier: priced.normalTrafficMultiplier,
      rushHourMultiplier: priced.rushHourMultiplier,
    },

    edges,
    baseFare: priced.baseFare,
    distanceFare,
    timeFare,
    preTrafficSubtotal,
    trafficMultiplier,
    trafficAdjustment,
    trafficAdjustedFare,
    minimumFare: priced.minimumFare,
    minimumFareApplied,
    finalFare,
  };
};
