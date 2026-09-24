import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import {
  calculateSoloFare,
  FareCalculationError,
  formatKilometers,
  formatMinutes,
  formatMoney,
  formatMultiplier,
  isQuoteExpired,
  MAX_STORABLE_AMOUNT,
  quoteExpiresAt,
} from '../../src/services/fare.calculator.js';

/**
 * The fare formula, tested directly.
 *
 * Every input here is a decimal string, because that is what the database hands
 * the calculation for a `numeric` column and what the seed file contains. The
 * assertions are on exact strings: `"10.30"`, never `10.299999999999999`. That
 * is the whole point -- a money assertion that passes for the nearest double is
 * not a money assertion.
 */

let chain = 0;
const nextEdge = () => {
  chain += 1;
  return `edge-test-${chain}-to-${chain + 1}`;
};

const policy = (overrides = {}) => ({
  code: 'test-solo',
  version: 1,
  name: 'Test policy',
  currency: 'BDT',
  baseFare: '10.00',
  perKilometerRate: '10.00',
  perMinuteRate: '1.00',
  minimumFare: '0.00',
  normalTrafficMultiplier: '1.00',
  rushHourMultiplier: '2.00',
  quoteTtlSeconds: 300,
  roundingScale: 2,
  ...overrides,
});

const leg = (overrides = {}) => ({
  edgeCode: nextEdge(),
  direction: 'FORWARD',
  distanceMeters: 1000,
  durationSeconds: 600,
  fareWeight: '1.000',
  ...overrides,
});

/**
 * Prices a single leg and reports the totals the routing layer would report.
 *
 * `trafficProfile` defaults to NORMAL here for brevity. That default belongs to
 * the test, not to the calculator: `callCalculator` below passes exactly what it
 * is given, and is what the "missing input" tests use.
 */
const price = ({ legs, policy: farePolicy, trafficProfile = 'NORMAL', overrides = {} } = {}) => {
  const priced = legs ?? [leg()];

  return calculateSoloFare({
    policy: farePolicy ?? policy(),
    legs: priced,
    distanceMeters: priced.reduce((total, item) => total + item.distanceMeters, 0),
    durationSeconds: priced.reduce((total, item) => total + item.durationSeconds, 0),
    trafficProfile,
    ...overrides,
  });
};

/** Calls the calculator with exactly these arguments -- no test-side defaults. */
const callCalculator = (overrides = {}) =>
  calculateSoloFare({
    policy: policy(),
    legs: [leg()],
    distanceMeters: 1000,
    durationSeconds: 600,
    trafficProfile: 'NORMAL',
    ...overrides,
  });

const money = (result) => ({
  baseFare: formatMoney(result.baseFare, result.roundingScale),
  distanceFare: formatMoney(result.distanceFare, result.roundingScale),
  timeFare: formatMoney(result.timeFare, result.roundingScale),
  preTrafficSubtotal: formatMoney(result.preTrafficSubtotal, result.roundingScale),
  trafficMultiplier: formatMultiplier(result.trafficMultiplier, result.roundingScale),
  trafficAdjustment: formatMoney(result.trafficAdjustment, result.roundingScale),
  minimumFare: formatMoney(result.minimumFare, result.roundingScale),
  finalFare: formatMoney(result.finalFare, result.roundingScale),
});

const expectFailure = (fn, pattern) => {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof FareCalculationError, `expected a FareCalculationError, got ${err.name}`);
    if (pattern) assert.match(err.reason, pattern);
    return true;
  });
};

describe('exact decimal money', () => {
  it('adds values that binary floating point cannot add', () => {
    // 0.1 + 0.2 in doubles is 0.30000000000000004. In decimal it is 0.30.
    const result = price({
      policy: policy({ baseFare: '0.10', perKilometerRate: '0.20', perMinuteRate: '0.30' }),
      legs: [leg({ distanceMeters: 1000, durationSeconds: 600 })],
    });

    assert.strictEqual(money(result).baseFare, '0.10');
    assert.strictEqual(money(result).distanceFare, '0.20');
    assert.strictEqual(money(result).timeFare, '3.00');
    assert.strictEqual(money(result).finalFare, '3.30');
  });

  it('keeps every money figure an exact Decimal, never a JavaScript number', () => {
    const result = price();

    for (const value of [
      result.baseFare,
      result.distanceFare,
      result.timeFare,
      result.preTrafficSubtotal,
      result.trafficMultiplier,
      result.trafficAdjustment,
      result.minimumFare,
      result.finalFare,
    ]) {
      assert.ok(value instanceof Prisma.Decimal, 'money must be a Decimal');
      assert.strictEqual(typeof value, 'object');
    }
  });

  it('refuses a JavaScript number for money, rather than converting it', () => {
    expectFailure(() => price({ policy: policy({ baseFare: 40 }) }), /never a JavaScript number/);
    expectFailure(() => price({ legs: [leg({ fareWeight: 1.5 })] }), /never a JavaScript number/);
  });

  it('refuses a value that is not a decimal at all', () => {
    expectFailure(() => price({ legs: [leg({ fareWeight: 'not-a-number' })] }), /is not a decimal/);
  });
});

describe('the fare formula', () => {
  it('includes the base fare exactly once', () => {
    const result = price({
      policy: policy({ baseFare: '40.00', perKilometerRate: '0.00', perMinuteRate: '0.00' }),
    });

    assert.strictEqual(money(result).baseFare, '40.00');
    assert.strictEqual(money(result).distanceFare, '0.00');
    assert.strictEqual(money(result).timeFare, '0.00');
    assert.strictEqual(money(result).preTrafficSubtotal, '40.00');
    assert.strictEqual(money(result).finalFare, '40.00');
  });

  it('charges the per-kilometre rate over the network edge distances', () => {
    // 1.000 km + 0.500 km at 10.00/km.
    const result = price({
      policy: policy({ baseFare: '0.00', perMinuteRate: '0.00' }),
      legs: [leg({ distanceMeters: 1000 }), leg({ distanceMeters: 500 })],
    });

    assert.deepStrictEqual(
      result.edges.map((edge) => formatMoney(edge.distanceCharge, result.roundingScale)),
      ['10.00', '5.00'],
    );
    assert.strictEqual(money(result).distanceFare, '15.00');
  });

  it('charges the per-minute rate over the routed duration', () => {
    // 90 s is 1.5 minutes at 2.00/min.
    const result = price({
      policy: policy({ baseFare: '0.00', perKilometerRate: '0.00', perMinuteRate: '2.00' }),
      legs: [leg({ durationSeconds: 90 })],
    });

    assert.strictEqual(formatMinutes(90), '1.50');
    assert.strictEqual(money(result).timeFare, '3.00');
  });

  it('makes the distance fare the exact sum of the per-edge charges', () => {
    const result = price({
      policy: policy({ baseFare: '0.00', perKilometerRate: '18.00', perMinuteRate: '0.00' }),
      legs: [
        leg({ distanceMeters: 2214, fareWeight: '1.500' }),
        leg({ distanceMeters: 445, fareWeight: '0.750' }),
        leg({ distanceMeters: 1 }),
      ],
    });

    const charges = result.edges.map((edge) => edge.distanceCharge);
    const summed = charges.reduce((total, charge) => total.plus(charge), new Prisma.Decimal(0));

    assert.ok(
      summed.equals(result.distanceFare),
      'a quote has to be auditable: the stored per-edge charges must add up',
    );
    assert.strictEqual(money(result).distanceFare, '65.81');
  });

  it('keeps the stored components adding up to the final fare', () => {
    const result = price({
      policy: policy({ baseFare: '40.00', minimumFare: '0.00', rushHourMultiplier: '1.10' }),
      trafficProfile: 'RUSH_HOUR',
    });

    const subtotal = result.baseFare.plus(result.distanceFare).plus(result.timeFare);
    assert.ok(subtotal.equals(result.preTrafficSubtotal));
    assert.ok(result.preTrafficSubtotal.plus(result.trafficAdjustment).equals(result.finalFare));
  });

  it('makes the final fare the greater of the floor and the adjusted subtotal', () => {
    const above = price({
      policy: policy({ baseFare: '118.75', minimumFare: '80.00', perKilometerRate: '0.00', perMinuteRate: '0.00', rushHourMultiplier: '1.10' }),
      trafficProfile: 'RUSH_HOUR',
    });
    const below = price({
      policy: policy({ baseFare: '30.00', minimumFare: '80.00', rushHourMultiplier: '1.10' }),
      trafficProfile: 'RUSH_HOUR',
    });

    assert.strictEqual(money(above).finalFare, '130.63');
    assert.strictEqual(money(below).finalFare, '80.00');
    assert.ok(
      Prisma.Decimal.max(above.minimumFare, above.preTrafficSubtotal.plus(above.trafficAdjustment)).equals(
        above.finalFare,
      ),
    );
    assert.ok(
      Prisma.Decimal.max(below.minimumFare, below.preTrafficSubtotal.plus(below.trafficAdjustment)).equals(
        below.finalFare,
      ),
    );
  });
});

describe('edge fare weight', () => {
  it('multiplies the distance charge', () => {
    const single = price({
      policy: policy({ baseFare: '0.00', perMinuteRate: '0.00' }),
      legs: [leg({ distanceMeters: 1000, fareWeight: '1.000' })],
    });
    const weighted = price({
      policy: policy({ baseFare: '0.00', perMinuteRate: '0.00' }),
      legs: [leg({ distanceMeters: 1000, fareWeight: '2.500' })],
    });

    assert.strictEqual(money(single).distanceFare, '10.00');
    assert.strictEqual(money(weighted).distanceFare, '25.00');
  });

  it('does not touch the time fare, so it cannot act as a second time charge', () => {
    const result = price({
      policy: policy({ baseFare: '0.00', perKilometerRate: '0.00', perMinuteRate: '2.00' }),
      legs: [leg({ durationSeconds: 90, fareWeight: '9.000' })],
    });

    assert.strictEqual(money(result).timeFare, '3.00');
  });

  it('records the weight and the charge it produced on every leg', () => {
    const result = price({
      policy: policy({ baseFare: '0.00', perKilometerRate: '18.00' }),
      legs: [leg({ distanceMeters: 2214, fareWeight: '1.500' })],
    });

    assert.strictEqual(result.edges[0].fareWeight.toString(), '1.5');
    assert.strictEqual(formatMoney(result.edges[0].distanceCharge, result.roundingScale), '59.78');
    assert.strictEqual(result.edges[0].sequence, 1);
  });

  it('treats a missing, zero, negative or non-finite weight as a graph-data error', () => {
    expectFailure(() => price({ legs: [leg({ fareWeight: undefined })] }), /fare weight.*is missing/);
    expectFailure(() => price({ legs: [leg({ fareWeight: '0.000' })] }), /which is not positive/);
    expectFailure(() => price({ legs: [leg({ fareWeight: '-1.000' })] }), /which is not positive/);
    expectFailure(() => price({ legs: [leg({ fareWeight: 'Infinity' })] }), /finite decimal|is not a decimal/);
  });

  it('never falls back to a default weight', () => {
    // A leg with no weight must fail loudly rather than being priced as 1.0.
    expectFailure(
      () => price({ legs: [{ ...leg(), fareWeight: null }] }),
      /fare weight of edge .* is missing/,
    );
  });
});

describe('traffic multiplier', () => {
  const subtotalOf = (result) => result.preTrafficSubtotal;

  it('uses the normal multiplier outside the peak', () => {
    const result = price({
      policy: policy({ baseFare: '100.00', perKilometerRate: '0.00', perMinuteRate: '0.00' }),
      trafficProfile: 'NORMAL',
    });

    assert.strictEqual(money(result).trafficMultiplier, '1.00');
    assert.strictEqual(money(result).trafficAdjustment, '0.00');
    assert.strictEqual(money(result).finalFare, '100.00');
  });

  it('uses the rush-hour multiplier in the peak', () => {
    const result = price({
      policy: policy({ baseFare: '100.00', perKilometerRate: '0.00', perMinuteRate: '0.00' }),
      trafficProfile: 'RUSH_HOUR',
    });

    assert.strictEqual(money(result).trafficMultiplier, '2.00');
    assert.strictEqual(money(result).trafficAdjustment, '100.00');
    assert.strictEqual(money(result).finalFare, '200.00');
  });

  it('applies the multiplier exactly once', () => {
    // 100.00 × 1.10 = 110.00. Applying the multiplier a second time (121.00) or
    // applying it to the adjusted total would both look plausible and be wrong.
    const result = price({
      policy: policy({
        baseFare: '100.00',
        perKilometerRate: '0.00',
        perMinuteRate: '0.00',
        rushHourMultiplier: '1.10',
      }),
      trafficProfile: 'RUSH_HOUR',
    });

    assert.strictEqual(subtotalOf(result).toString(), '100');
    assert.strictEqual(money(result).trafficAdjustment, '10.00');
    assert.strictEqual(money(result).finalFare, '110.00');
    assert.notStrictEqual(money(result).finalFare, '121.00');
  });

  it('rounds the adjustment, not the adjusted total', () => {
    // 118.75 × 1.10 = 130.625. Rounding the *total* would give 130.63 as well,
    // but the adjustment is what has to be recorded: 11.875 -> 11.88, and
    // 118.75 + 11.88 = 130.63.
    const result = price({
      policy: policy({
        baseFare: '118.75',
        perKilometerRate: '0.00',
        perMinuteRate: '0.00',
        rushHourMultiplier: '1.10',
      }),
      trafficProfile: 'RUSH_HOUR',
    });

    assert.strictEqual(money(result).trafficAdjustment, '11.88');
    assert.strictEqual(money(result).finalFare, '130.63');
  });

  it('rejects an unknown or absent traffic profile rather than guessing one', () => {
    expectFailure(() => callCalculator({ trafficProfile: 'PEAK' }), /traffic profile/);
    expectFailure(() => callCalculator({ trafficProfile: undefined }), /traffic profile/);
    expectFailure(() => callCalculator({ trafficProfile: null }), /traffic profile/);
  });
});

describe('minimum fare', () => {
  it('raises a cheap fare to the minimum and says so', () => {
    const result = price({
      policy: policy({ baseFare: '40.00', minimumFare: '80.00' }),
    });

    assert.ok(result.preTrafficSubtotal.lessThan(result.minimumFare), 'the fare must be under the floor');
    assert.strictEqual(result.minimumFareApplied, true);
    assert.strictEqual(money(result).finalFare, '80.00');
  });

  it('does not claim the minimum was applied when the fare is already above it', () => {
    const result = price({
      policy: policy({ baseFare: '100.00', minimumFare: '80.00' }),
    });

    assert.strictEqual(money(result).preTrafficSubtotal, '120.00');
    assert.strictEqual(result.minimumFareApplied, false);
    assert.strictEqual(money(result).finalFare, '120.00');
  });

  it('treats a fare exactly equal to the minimum as not applied', () => {
    // The boundary is `minimumFare > adjusted`, so an exact match is the
    // calculated fare rather than a floor being imposed. 60.00 + 10.00 + 10.00.
    const result = price({
      policy: policy({ baseFare: '60.00', minimumFare: '80.00' }),
    });

    assert.strictEqual(money(result).preTrafficSubtotal, '80.00');
    assert.strictEqual(result.minimumFareApplied, false);
    assert.strictEqual(money(result).finalFare, '80.00');
  });

  it('is applied after the traffic multiplier, never before', () => {
    // Subtotal 30.00 + 10.00 + 10.00 = 50.00, rush multiplier 1.10 -> 55.00,
    // still under the 80.00 floor.
    const result = price({
      policy: policy({ baseFare: '30.00', minimumFare: '80.00', rushHourMultiplier: '1.10' }),
      trafficProfile: 'RUSH_HOUR',
    });

    assert.strictEqual(money(result).preTrafficSubtotal, '50.00');
    assert.strictEqual(money(result).trafficAdjustment, '5.00');
    assert.strictEqual(money(result).finalFare, '80.00');
    assert.strictEqual(result.minimumFareApplied, true);
  });
});

describe('rounding', () => {
  it('rounds half up, deterministically', () => {
    const half = price({
      policy: policy({ baseFare: '0.00', perKilometerRate: '0.005', perMinuteRate: '0.00' }),
      legs: [leg({ distanceMeters: 1000 })],
    });
    const under = price({
      policy: policy({ baseFare: '0.00', perKilometerRate: '0.0049', perMinuteRate: '0.00' }),
      legs: [leg({ distanceMeters: 1000 })],
    });

    assert.strictEqual(money(half).distanceFare, '0.01');
    assert.strictEqual(money(under).distanceFare, '0.00');
  });

  it('rounds each money figure to the policy scale, and no further', () => {
    // 2.214 km × 18.00 = 39.852 -> 39.85 (half up), which is also what the
    // unrounded arithmetic rounds to; the point is that it is 39.85 and not
    // 39.852 or 39.86.
    const result = price({
      policy: policy({ baseFare: '0.00', perKilometerRate: '18.00', perMinuteRate: '0.00' }),
      legs: [leg({ distanceMeters: 2214 })],
    });

    assert.strictEqual(money(result).distanceFare, '39.85');
    assert.strictEqual(result.distanceFare.toFixed(6), '39.850000');
  });

  it('rounds exactly what the duration produces, at full internal precision', () => {
    // 569 s is 9.48333… minutes; 2.00/min gives 18.9666… -> 18.97. Rounding the
    // minutes to 9.48 first would give 18.96, which is a different fare.
    const result = price({
      policy: policy({ baseFare: '0.00', perKilometerRate: '0.00', perMinuteRate: '2.00' }),
      legs: [leg({ durationSeconds: 569 })],
    });

    assert.strictEqual(formatMinutes(569), '9.48');
    assert.strictEqual(money(result).timeFare, '18.97');
  });

  it('honours a whole-currency rounding scale', () => {
    const result = calculateSoloFare({
      policy: policy({ baseFare: '40.50', perKilometerRate: '0.00', perMinuteRate: '0.00', roundingScale: 0 }),
      legs: [leg()],
      distanceMeters: 1000,
      durationSeconds: 600,
      trafficProfile: 'NORMAL',
    });

    // 40.50 at scale 0 is 41 by half-up, not 40.
    assert.strictEqual(formatMoney(result.baseFare, result.roundingScale), '41');
    assert.strictEqual(formatMoney(result.finalFare, result.roundingScale), '41');
  });

  it('expresses configured amounts at the policy scale', () => {
    const result = price({
      policy: policy({ baseFare: '40.0050', minimumFare: '80.0049', perKilometerRate: '0.00', perMinuteRate: '0.00' }),
    });

    assert.strictEqual(money(result).baseFare, '40.01');
    assert.strictEqual(money(result).minimumFare, '80.00');
  });

  it('does not round the rates', () => {
    // A rate is a price per unit, not an amount: 0.005/km over 1 km is 0.005,
    // which is a real charge even though it rounds to a whole paisa.
    const result = price({
      policy: policy({ baseFare: '0.00', perKilometerRate: '0.005', perMinuteRate: '0.00' }),
      legs: [leg({ distanceMeters: 1000 })],
    });

    assert.strictEqual(result.policy.perKilometerRate.toString(), '0.005');
  });
});

describe('the policy it is given', () => {
  it('rejects a missing policy instead of substituting default rates', () => {
    expectFailure(() => callCalculator({ policy: null }), /no fare policy was supplied/);
    expectFailure(() => callCalculator({ policy: undefined }), /no fare policy was supplied/);
  });

  it('rejects an incomplete or invalid configuration', () => {
    expectFailure(() => callCalculator({ policy: policy({ code: '' }) }), /has no code/);
    expectFailure(() => callCalculator({ policy: policy({ version: 0 }) }), /version must be a positive integer/);
    expectFailure(() => callCalculator({ policy: policy({ currency: 'XYZ' }) }), /invalid currency/);
    expectFailure(() => callCalculator({ policy: policy({ roundingScale: 9 }) }), /invalid roundingScale/);
    expectFailure(() => callCalculator({ policy: policy({ quoteTtlSeconds: 0 }) }), /quoteTtlSeconds/);
    expectFailure(() => callCalculator({ policy: policy({ perKilometerRate: '-1.00' }) }), /negative rate/);
    expectFailure(() => callCalculator({ policy: policy({ baseFare: '-1.00' }) }), /negative amount/);
    expectFailure(() => callCalculator({ policy: policy({ rushHourMultiplier: '0.00' }) }), /not positive/);
    expectFailure(() => callCalculator({ policy: policy({ perMinuteRate: null }) }), /is missing/);
  });

  it('rejects an amount too large for the column that has to hold it', () => {
    expectFailure(
      () =>
        price({
          policy: policy({ baseFare: '0.00', perKilometerRate: '100000000.00', perMinuteRate: '0.00' }),
          legs: [leg({ distanceMeters: 1000 })],
        }),
      /too large to store/,
    );
    assert.strictEqual(MAX_STORABLE_AMOUNT.toString(), '100000000');
  });
});

describe('the route it is given', () => {
  it('rejects an empty route', () => {
    expectFailure(() => callCalculator({ legs: [] }), /no legs to price/);
    expectFailure(() => callCalculator({ legs: null }), /no legs to price/);
    expectFailure(() => callCalculator({ legs: undefined }), /no legs to price/);
  });

  it('rejects a leg without an edge code, distance, duration or direction', () => {
    expectFailure(() => callCalculator({ legs: [leg({ edgeCode: '' })] }), /has no edge code/);
    expectFailure(() => callCalculator({ legs: [leg({ distanceMeters: 0 })] }), /distance of edge/);
    expectFailure(() => callCalculator({ legs: [leg({ durationSeconds: -1 })] }), /duration of edge/);
    expectFailure(() => callCalculator({ legs: [leg({ direction: 'SIDEWAYS' })] }), /traversal direction/);
  });

  it('rejects legs that do not add up to the route totals', () => {
    // The router's totals are authoritative, so a disagreement means the priced
    // legs are not the journey that was routed.
    assert.throws(
      () =>
        calculateSoloFare({
          policy: policy(),
          legs: [leg({ distanceMeters: 1000 })],
          distanceMeters: 999,
          durationSeconds: 600,
          trafficProfile: 'NORMAL',
        }),
      /reports 999 m but its legs add up to 1000 m/,
    );

    assert.throws(
      () =>
        calculateSoloFare({
          policy: policy(),
          legs: [leg({ durationSeconds: 600 })],
          distanceMeters: 1000,
          durationSeconds: 601,
          trafficProfile: 'NORMAL',
        }),
      /reports 601 s but its legs add up to 600 s/,
    );
  });
});

describe('quote expiry', () => {
  it('is createdAt plus the policy TTL, exactly', () => {
    const createdAt = new Date('2026-09-24T02:41:00.000Z');
    const expiresAt = quoteExpiresAt(createdAt, 300);

    assert.strictEqual(expiresAt.toISOString(), '2026-09-24T02:46:00.000Z');
    assert.strictEqual(expiresAt.getTime() - createdAt.getTime(), 300_000);
  });

  it('treats the expiry instant itself as expired', () => {
    const quote = { expiresAt: new Date('2026-09-24T02:46:00.000Z') };

    assert.strictEqual(isQuoteExpired(quote, new Date('2026-09-24T02:45:59.999Z')), false);
    assert.strictEqual(isQuoteExpired(quote, new Date('2026-09-24T02:46:00.000Z')), true);
    assert.strictEqual(isQuoteExpired(quote, new Date('2026-09-24T02:46:00.001Z')), true);
  });

  it('refuses a TTL that could not produce a deadline', () => {
    assert.throws(() => quoteExpiresAt(new Date(), 0), /quoteTtlSeconds/);
  });
});

describe('presentation helpers', () => {
  it('formats kilometres to the metre and minutes to the second', () => {
    assert.strictEqual(formatKilometers(2214), '2.214');
    assert.strictEqual(formatKilometers(445), '0.445');
    assert.strictEqual(formatMinutes(840), '14.00');
    assert.strictEqual(formatMinutes(569), '9.48');
  });

  it('never prints a multiplier with fewer than two decimals', () => {
    assert.strictEqual(formatMultiplier('1.1', 2), '1.10');
    assert.strictEqual(formatMultiplier('1', 2), '1.00');
    assert.strictEqual(formatMultiplier('1.125', 3), '1.125');
  });

  it('pads money to the scale it is presented at', () => {
    assert.strictEqual(formatMoney('0', 2), '0.00');
    assert.strictEqual(formatMoney(new Prisma.Decimal('166.2'), 2), '166.20');
  });
});
