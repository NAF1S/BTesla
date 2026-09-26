import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import {
  calculateSoloFare,
  CHARGE_SCALE,
  FareCalculationError,
  formatKilometers,
  formatMinutes,
  formatMoney,
  formatMultiplier,
  quoteExpiresAt,
} from './fare.calculator.js';
import * as routing from './routing.service.js';

/**
 * Solo-fare quoting.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * It composes three things that already exist or are pure:
 *
 *   1. the authoritative route, from the routing service -- this file contains
 *      no pathfinding at all, and no way to influence which path is taken;
 *   2. the fare formula, from fare.calculator.js -- pure, so it is unit tested
 *      without a database;
 *   3. persistence, into the immutable fare_quotes table.
 *
 * Around those it does the I/O the formula needs: the traversed edges' fare
 * weights, the pricing policy in force, the two service point ids, and the
 * INSERT.
 *
 * ---------------------------------------------------------------------------
 * WHAT A CLIENT CAN AND CANNOT INFLUENCE
 * ---------------------------------------------------------------------------
 * A request supplies two service point codes and an optional departure instant.
 * It cannot supply a distance, a duration, a fare weight, a traffic profile, a
 * policy code or version, or any monetary value: distance and duration come from
 * the router, the profile is derived on the server from the departure instant in
 * Asia/Dhaka, and the policy is chosen here from configuration. The controller
 * rejects unknown body fields, so an attempt to send any of them is a 400 rather
 * than a silently ignored field.
 *
 * ---------------------------------------------------------------------------
 * FARE WEIGHT
 * ---------------------------------------------------------------------------
 * `routing_edges.fare_weight` multiplies the *distance* charge of the edge it
 * belongs to. It is not a routing cost -- the router optimises duration -- so
 * changing a weight changes the price of a journey and never the path taken.
 *
 * ---------------------------------------------------------------------------
 * POLICY SELECTION (the one documented rule)
 * ---------------------------------------------------------------------------
 * The policy is the one that is **effective at the quote's departure instant**:
 * the highest version of the configured code that is active, whose
 * `effective_from <= departureAt`, and whose `effective_to` is null or
 * `> departureAt`. The window is half-open, exactly like the rush-hour windows,
 * so retiring v1 at the instant v2 starts leaves no gap and no overlap.
 *
 * Departure rather than creation is the passenger-facing answer: the price is
 * the one that applies to the journey being quoted. Creation time still decides
 * `expires_at`.
 *
 * A departure instant with no effective policy, or with more than one (an
 * overlapping configuration), is a server-side configuration failure and is
 * reported as one -- there is no fallback rate and no silent default.
 */

/** One message for every internal failure, so nothing internal reaches a client. */
export const FARE_FAILURE_MESSAGE = 'Fare calculation failed';
export const PRICING_NOT_CONFIGURED_MESSAGE = 'Fare pricing is not configured';
export const PRICING_AMBIGUOUS_MESSAGE = 'Fare pricing configuration is ambiguous';

/** routing_edges.fare_weight is numeric(6,3). */
const GRAPH_WEIGHT_SCALE = 3;

const fareFailure = (reason) => {
  console.error('[fare]', reason);
  return new ApiError(500, FARE_FAILURE_MESSAGE);
};

/**
 * Runs `work`, letting a deliberate ApiError (400/404/409/422 from validation or
 * routing) through unchanged and turning anything else -- a driver error, a
 * constraint violation, a bug -- into one controlled 500.
 */
const guarded = async (what, work) => {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw fareFailure(`${what}: ${err.message}`);
  }
};

/**
 * The policy effective at `at`, or a controlled failure.
 *
 * The code comes from configuration (`FARE_PRICING_CODE`), never from a request,
 * which is what stops a client from choosing a price.
 */
export const findEffectiveFarePolicy = async (at) => {
  const code = env.fare.pricingCode;

  const policies = await prisma.farePolicy.findMany({
    where: {
      code,
      active: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { version: 'desc' },
  });

  if (policies.length === 0) {
    console.error(`[fare] no active "${code}" policy is effective at ${at.toISOString()}`);
    throw new ApiError(500, PRICING_NOT_CONFIGURED_MESSAGE);
  }

  if (policies.length > 1) {
    console.error(
      `[fare] ${policies.length} active "${code}" policies are effective at ${at.toISOString()} ` +
        `(versions ${policies.map((policy) => policy.version).join(', ')})`,
    );
    throw new ApiError(500, PRICING_AMBIGUOUS_MESSAGE);
  }

  return policies[0];
};

/**
 * Fare weights for the edges a route actually used, keyed by edge code.
 *
 * Exported because the shared-fare calculation prices legs over the same graph
 * and must use the same weights: a second query would be a second definition of
 * what an edge costs.
 */
export const loadFareWeights = async (edgeCodes) => {
  const rows = await prisma.routingEdge.findMany({
    where: { code: { in: edgeCodes } },
    select: { code: true, fareWeight: true },
  });

  return new Map(rows.map((row) => [row.code, row.fareWeight]));
};

/** The two service point rows a quote points at. */
const loadServicePointIds = async (codes) => {
  const rows = await prisma.servicePoint.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true },
  });

  return new Map(rows.map((row) => [row.code, row.id]));
};

/**
 * Everything needed to explain which edges the fare was calculated over: their
 * codes in path order, the distance each contributed, the duration selected for
 * the traffic profile, its fare weight, and the charge that weight produced.
 *
 * This is the audit trail a later RideRequest will point at, so it is stored on
 * the quote rather than recomputed later from a graph that may since have
 * changed.
 */
const toRouteSnapshot = (route, fare) => ({
  trafficProfile: fare.trafficProfile,
  origin: { code: route.origin.code, name: route.origin.name },
  destination: { code: route.destination.code, name: route.destination.name },
  legCount: fare.edges.length,
  distanceMeters: fare.distanceMeters,
  distanceKilometers: formatKilometers(fare.distanceMeters),
  durationSeconds: fare.durationSeconds,
  durationMinutes: formatMinutes(fare.durationSeconds),
  distanceFare: formatMoney(fare.distanceFare, fare.roundingScale),
  edges: fare.edges.map((edge) => ({
    sequence: edge.sequence,
    edgeCode: edge.edgeCode,
    direction: edge.direction,
    distanceMeters: edge.distanceMeters,
    distanceKilometers: formatKilometers(edge.distanceMeters),
    durationSeconds: edge.durationSeconds,
    fareWeight: edge.fareWeight.toFixed(GRAPH_WEIGHT_SCALE),
    distanceCharge: formatMoney(edge.distanceCharge, fare.roundingScale),
  })),
  geometry: {
    type: route.geometry.type,
    coordinates: route.geometry.coordinates,
  },
});

/**
 * The component-by-component breakdown, plus the rates and quantities it came
 * from and the rounding rule that produced it. Money is stored as decimal
 * strings, matching the columns, so nothing is ever re-parsed through a float.
 */
const toFareBreakdown = (fare) => ({
  currency: fare.currency,
  pricingCode: fare.pricingCode,
  pricingVersion: fare.pricingVersion,
  trafficProfile: fare.trafficProfile,
  // `unit` is the fare rounding step, not a scale: the charged fare below is a
  // whole multiple of it, while every component keeps `scale` decimals.
  rounding: {
    scale: fare.roundingScale,
    mode: fare.roundingMode,
    unit: formatMoney(fare.fareRoundingUnit, CHARGE_SCALE),
  },
  quantities: {
    distanceMeters: fare.distanceMeters,
    distanceKilometers: formatKilometers(fare.distanceMeters),
    durationSeconds: fare.durationSeconds,
    durationMinutes: formatMinutes(fare.durationSeconds),
  },
  rates: {
    baseFare: formatMoney(fare.policy.baseFare, fare.roundingScale),
    perKilometerRate: fare.policy.perKilometerRate.toFixed(4),
    perMinuteRate: fare.policy.perMinuteRate.toFixed(4),
    minimumFare: formatMoney(fare.policy.minimumFare, fare.roundingScale),
    normalTrafficMultiplier: fare.policy.normalTrafficMultiplier.toFixed(4),
    rushHourMultiplier: fare.policy.rushHourMultiplier.toFixed(4),
    appliedTrafficMultiplier: formatMultiplier(fare.trafficMultiplier, fare.roundingScale),
  },
  components: {
    baseFare: formatMoney(fare.baseFare, fare.roundingScale),
    distanceFare: formatMoney(fare.distanceFare, fare.roundingScale),
    timeFare: formatMoney(fare.timeFare, fare.roundingScale),
    preTrafficSubtotal: formatMoney(fare.preTrafficSubtotal, fare.roundingScale),
    trafficMultiplier: formatMultiplier(fare.trafficMultiplier, fare.roundingScale),
    trafficAdjustment: formatMoney(fare.trafficAdjustment, fare.roundingScale),
    minimumFare: formatMoney(fare.minimumFare, fare.roundingScale),
    minimumFareApplied: fare.minimumFareApplied,
    // The fare the protections produced, and what the unit rounding did to it.
    // `finalFare` is the money that changes hands, so it is the one figure here
    // presented as a whole number rather than at the policy's scale.
    unroundedFare: formatMoney(fare.unroundedFare, fare.roundingScale),
    fareRoundingAdjustment: formatMoney(fare.fareRoundingAdjustment, fare.roundingScale),
    finalFare: formatMoney(fare.finalFare, CHARGE_SCALE),
  },
});

/**
 * Prices a solo journey and stores the immutable quote it produces.
 *
 * Returns the persisted quote together with the endpoints the route ran between,
 * which the serializer needs and the quote itself only stores as foreign keys.
 *
 * `passengerProfileId` is the owner of the quote. It comes from the
 * authenticated user (see `requirePassengerProfileId`), never from the request,
 * and it is what a ride request later checks before accepting the quote. A quote
 * without an owner can never be accepted -- the migration leaves legacy rows
 * NULL on purpose, so that "unowned" stays distinguishable from "mine".
 */
export const createSoloFareQuote = async ({
  passengerProfileId,
  originServicePointCode,
  destinationServicePointCode,
  departureAt,
}) => {
  if (typeof passengerProfileId !== 'string' || passengerProfileId === '') {
    throw new ApiError(403, 'A fare quote must be created for an authenticated passenger');
  }
  // 1-2. Input validation and pathfinding belong to the routing service: the
  // same codes, the same identity checks, the same 404/409/422 semantics, and
  // one implementation of the shortest-path search.
  const route = await guarded('routing the journey', () =>
    routing.estimateRoute({
      originServicePointCode,
      destinationServicePointCode,
      departureAt,
    }),
  );

  // 3-4. The edges the route actually used, for the weight of each one.
  const weights = await guarded('loading the routed edges', () =>
    loadFareWeights(route.legs.map((leg) => leg.edgeCode)),
  );

  const legs = route.legs.map((leg) => ({ ...leg, fareWeight: weights.get(leg.edgeCode) }));

  // 5. The policy in force at the departure instant.
  const policy = await guarded('loading the fare policy', () =>
    findEffectiveFarePolicy(route.departureAt),
  );

  // 6-10. The formula itself: pure, exact decimal, and testable on its own.
  let fare;
  try {
    fare = calculateSoloFare({
      policy,
      legs,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      trafficProfile: route.trafficProfile,
    });
  } catch (err) {
    if (err instanceof FareCalculationError) throw fareFailure(err.reason);
    throw err;
  }

  const pointIds = await guarded('loading the service points', () =>
    loadServicePointIds([originServicePointCode, destinationServicePointCode]),
  );

  const originServicePointId = pointIds.get(originServicePointCode);
  const destinationServicePointId = pointIds.get(destinationServicePointCode);
  if (!originServicePointId || !destinationServicePointId) {
    throw fareFailure('the routed endpoints are no longer available');
  }

  // The quote's own clock: creation and expiry are derived from one instant, so
  // `expires_at - created_at` is exactly the policy's TTL.
  const createdAt = new Date();
  const expiresAt = quoteExpiresAt(createdAt, fare.quoteTtlSeconds);
  const estimatedArrivalAt = new Date(route.departureAt.getTime() + fare.durationSeconds * 1000);

  const quote = await guarded('storing the quote', () =>
    prisma.fareQuote.create({
      data: {
        passengerProfileId,
        originServicePointId,
        destinationServicePointId,
        departureAt: route.departureAt,
        estimatedArrivalAt,
        trafficProfile: fare.trafficProfile,
        distanceMeters: fare.distanceMeters,
        durationSeconds: fare.durationSeconds,
        farePolicyId: policy.id,
        pricingCode: fare.pricingCode,
        pricingVersion: fare.pricingVersion,
        currency: fare.currency,
        // Decimal values throughout: nothing here has been near a JavaScript number.
        baseFare: fare.baseFare,
        distanceFare: fare.distanceFare,
        timeFare: fare.timeFare,
        preTrafficSubtotal: fare.preTrafficSubtotal,
        trafficMultiplier: fare.trafficMultiplier,
        trafficAdjustment: fare.trafficAdjustment,
        minimumFare: fare.minimumFare,
        minimumFareApplied: fare.minimumFareApplied,
        finalFare: fare.finalFare,
        fareRoundingUnit: fare.fareRoundingUnit,
        fareRoundingAdjustment: fare.fareRoundingAdjustment,
        routeSnapshot: toRouteSnapshot(route, fare),
        fareBreakdown: toFareBreakdown(fare),
        expiresAt,
        createdAt,
      },
    }),
  );

  return {
    quote,
    origin: route.origin,
    destination: route.destination,
  };
};
