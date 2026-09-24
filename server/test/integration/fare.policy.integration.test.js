import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { env } from '../../src/config/env.js';
import { FARE_POLICIES } from '../../src/db/seeds/fare.data.js';
import {
  PRICING_AMBIGUOUS_MESSAGE,
  PRICING_NOT_CONFIGURED_MESSAGE,
  findEffectiveFarePolicy,
} from '../../src/services/fare.service.js';
import { ApiError } from '../../src/utils/ApiError.js';
import {
  closePool,
  expectPgError,
  pool,
  prepareDatabase,
  runPricingSeed,
  withRollback,
} from '../helpers/db.js';

/**
 * Fare policies as data: the seed, the versioning rules, the configuration
 * constraints, and which version is selected for an instant.
 *
 * This suite manipulates policy rows directly rather than through the API,
 * because that is where these rules live -- and it uses its own policy code for
 * fixtures so it can never disturb the seeded `dhaka-solo` version the other
 * suites quote against.
 *
 * Asia/Dhaka is UTC+06:00, and every instant here is written with an explicit
 * offset or as UTC so nothing depends on the machine's zone.
 */

const TEST_CODE = 'test-selection-solo';

/** The seeded policy the API is configured to quote with. */
const seededCode = () => env.fare.pricingCode;

const INSTANT = (iso) => new Date(iso);

/** A policy row, shaped like a seed entry: money as decimal strings. */
const policyData = (overrides = {}) => ({
  code: TEST_CODE,
  version: 1,
  name: 'Test selection policy',
  currency: 'BDT',
  baseFare: '40.00',
  perKilometerRate: '18.00',
  perMinuteRate: '2.00',
  minimumFare: '80.00',
  normalTrafficMultiplier: '1.0000',
  rushHourMultiplier: '1.1000',
  quoteTtlSeconds: 300,
  roundingScale: 2,
  active: true,
  effectiveFrom: INSTANT('2020-01-01T00:00:00.000Z'),
  effectiveTo: null,
  ...overrides,
});

const clearFixturePolicies = () => pool.farePolicy.deleteMany({ where: { code: TEST_CODE } });

/** Runs `work` with the API configured to quote with a different policy code. */
const withPricingCode = async (code, work) => {
  const previous = env.fare.pricingCode;
  env.fare.pricingCode = code;
  try {
    return await work();
  } finally {
    env.fare.pricingCode = previous;
  }
};

/** Asserts that `work()` fails with the given controlled ApiError. */
const expectApiError = async (work, status, message) => {
  await assert.rejects(work, (err) => {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${err.name}: ${err.message}`);
    assert.strictEqual(err.statusCode, status);
    if (message) assert.strictEqual(err.message, message);
    return true;
  });
};

let originServicePointId;
let destinationServicePointId;

before(async () => {
  await prepareDatabase();
  await clearFixturePolicies();

  const points = await pool.servicePoint.findMany({ select: { id: true }, orderBy: { code: 'asc' } });
  assert.ok(points.length >= 2, 'the location seed must provide service points');
  [originServicePointId, destinationServicePointId] = [points[0].id, points[1].id];
});

after(async () => {
  await clearFixturePolicies();
  await closePool();
});

describe('the seeded pricing policy', () => {
  it('is the code the API is configured to use', () => {
    // Guards against the seed and the configuration drifting apart: the code the
    // API quotes with has to be the code the seeder creates.
    assert.strictEqual(FARE_POLICIES[0].code, seededCode());
  });

  it('exists once, active, in BDT, with the seeded rates', () => {
    return (async () => {
      const policies = await pool.farePolicy.findMany({ where: { code: seededCode() } });

      assert.strictEqual(policies.length, 1);
      const policy = policies[0];
      const seeded = FARE_POLICIES[0];

      assert.strictEqual(policy.version, seeded.version);
      assert.strictEqual(policy.currency, 'BDT');
      assert.strictEqual(policy.active, true);
      assert.strictEqual(policy.effectiveTo, null);
      // Money is compared numerically: a `numeric` column has no trailing-zero
      // opinions, so 40.00 comes back as 40.
      for (const field of [
        'baseFare',
        'perKilometerRate',
        'perMinuteRate',
        'minimumFare',
        'normalTrafficMultiplier',
        'rushHourMultiplier',
      ]) {
        assert.ok(
          policy[field].equals(new Prisma.Decimal(seeded[field])),
          `${field} must match the seed (${policy[field].toString()} vs ${seeded[field]})`,
        );
      }
      assert.strictEqual(policy.quoteTtlSeconds, seeded.quoteTtlSeconds);
      assert.strictEqual(policy.roundingScale, seeded.roundingScale);
    })();
  });

  it('is idempotent: re-seeding never creates a second version', async () => {
    const before = await pool.farePolicy.findMany({ where: { code: seededCode() } });

    const first = await runPricingSeed();
    const second = await runPricingSeed();

    const after = await pool.farePolicy.findMany({ where: { code: seededCode() } });

    assert.strictEqual(after.length, 1, 'a version must never be duplicated by seeding');
    assert.strictEqual(after[0].id, before[0].id, 'the existing row must be reused, not replaced');

    // The seeded version is `updated` while no quote references it and
    // `preserved` once one does -- which of the two depends on whether another
    // suite has already created a quote against it, so both are acceptable here.
    for (const summary of [first, second]) {
      assert.strictEqual(summary.created, 0, 'the seeded version already exists');
      assert.strictEqual(summary.updated + summary.preserved, 1);
    }
  });

  it('never drops a policy version it did not create', async () => {
    await pool.farePolicy.create({ data: policyData({ version: 9 }) });
    try {
      await runPricingSeed();

      const policies = await pool.farePolicy.findMany({ where: { code: TEST_CODE } });
      assert.strictEqual(policies.length, 1, 'seeding must not delete unrelated rows');
    } finally {
      await clearFixturePolicies();
    }
  });
});

describe('policy selection', () => {
  it('selects the version effective at the departure instant', async () => {
    const handover = INSTANT('2026-06-01T00:00:00.000Z');

    await withPricingCode(TEST_CODE, async () => {
      // v1 ends exactly where v2 begins: the window is half-open, so there is no
      // gap and no overlap at the handover instant.
      await pool.farePolicy.create({
        data: policyData({ version: 1, baseFare: '40.00', effectiveTo: handover }),
      });
      await pool.farePolicy.create({
        data: policyData({ version: 2, baseFare: '55.00', effectiveFrom: handover }),
      });

      try {
        const before = await findEffectiveFarePolicy(INSTANT('2026-05-31T23:59:59.999Z'));
        const at = await findEffectiveFarePolicy(handover);
        const after = await findEffectiveFarePolicy(INSTANT('2026-06-02T00:00:00.000Z'));

        assert.strictEqual(before.version, 1);
        assert.strictEqual(at.version, 2, 'the handover instant belongs to the newer version');
        assert.strictEqual(after.version, 2);
        assert.strictEqual(after.baseFare.toString(), '55');
      } finally {
        await clearFixturePolicies();
      }
    });
  });

  it('ignores an inactive version and one whose window has not opened yet', async () => {
    await withPricingCode(TEST_CODE, async () => {
      await pool.farePolicy.create({ data: policyData({ version: 1, active: false }) });

      try {
        await expectApiError(
          () => findEffectiveFarePolicy(INSTANT('2026-09-24T02:41:00.000Z')),
          500,
          PRICING_NOT_CONFIGURED_MESSAGE,
        );

        await pool.farePolicy.create({
          data: policyData({
            version: 2,
            active: true,
            effectiveFrom: INSTANT('2027-01-01T00:00:00.000Z'),
          }),
        });

        await expectApiError(
          () => findEffectiveFarePolicy(INSTANT('2026-09-24T02:41:00.000Z')),
          500,
          PRICING_NOT_CONFIGURED_MESSAGE,
        );

        // Once its window opens, it is selected.
        const opened = await findEffectiveFarePolicy(INSTANT('2027-06-01T00:00:00.000Z'));
        assert.strictEqual(opened.version, 2);
      } finally {
        await clearFixturePolicies();
      }
    });
  });

  it('refuses an ambiguous configuration instead of guessing a price', async () => {
    await withPricingCode(TEST_CODE, async () => {
      // Two active versions whose windows both cover the instant: a
      // configuration error, and there is no correct answer to fall back on.
      await pool.farePolicy.create({ data: policyData({ version: 1 }) });
      await pool.farePolicy.create({ data: policyData({ version: 2 }) });

      try {
        await expectApiError(
          () => findEffectiveFarePolicy(INSTANT('2026-09-24T02:41:00.000Z')),
          500,
          PRICING_AMBIGUOUS_MESSAGE,
        );
      } finally {
        await clearFixturePolicies();
      }
    });
  });

  it('reports a missing policy as a server-side failure, never as a free ride', async () => {
    await withPricingCode(TEST_CODE, async () => {
      await expectApiError(
        () => findEffectiveFarePolicy(INSTANT('2026-09-24T02:41:00.000Z')),
        500,
        PRICING_NOT_CONFIGURED_MESSAGE,
      );
    });
  });
});

describe('policy configuration constraints', () => {
  const rejectPolicy = (overrides, sqlState = '23514') =>
    withRollback((tx) =>
      expectPgError(tx, () => tx.farePolicy.create({ data: policyData(overrides) }), sqlState),
    );

  it('refuses a duplicate (code, version)', async () => {
    await withRollback(async (tx) => {
      await tx.farePolicy.create({ data: policyData({ version: 3 }) });
      await expectPgError(
        tx,
        () => tx.farePolicy.create({ data: policyData({ version: 3 }) }),
        '23505',
      );
    });
  });

  it('refuses a non-positive version', async () => {
    await rejectPolicy({ version: 0 });
    await rejectPolicy({ version: -1 });
  });

  it('refuses negative rates and negative amounts', async () => {
    await rejectPolicy({ baseFare: '-0.01' });
    await rejectPolicy({ perKilometerRate: '-1.00' });
    await rejectPolicy({ perMinuteRate: '-1.00' });
    await rejectPolicy({ minimumFare: '-1.00' });
  });

  it('refuses a multiplier that is not positive', async () => {
    await rejectPolicy({ normalTrafficMultiplier: '0.0000' });
    await rejectPolicy({ rushHourMultiplier: '0.0000' });
    await rejectPolicy({ rushHourMultiplier: '-1.1000' });
  });

  it('refuses a quote TTL that is not positive', async () => {
    await rejectPolicy({ quoteTtlSeconds: 0 });
    await rejectPolicy({ quoteTtlSeconds: -300 });
  });

  it('refuses a rounding scale outside 0-6', async () => {
    await rejectPolicy({ roundingScale: -1 });
    await rejectPolicy({ roundingScale: 7 });
  });

  it('refuses an effective window that ends before it starts', async () => {
    await rejectPolicy({
      effectiveFrom: INSTANT('2026-06-01T00:00:00.000Z'),
      effectiveTo: INSTANT('2026-05-01T00:00:00.000Z'),
    });
  });

  it('refuses a currency other than BDT', async () => {
    await rejectPolicy({ currency: 'USD' });
    await rejectPolicy({ currency: 'usd' });
  });

  it('allows a zero base fare, because a free first unit is a valid configuration', async () => {
    await withRollback(async (tx) => {
      const policy = await tx.farePolicy.create({ data: policyData({ baseFare: '0.00' }) });
      assert.strictEqual(policy.baseFare.toString(), '0');
    });
  });
});

describe('quoted policy versions are frozen', () => {
  /** A stored quote, so the freeze has something to trigger on. */
  const quoteData = (policyId, overrides = {}) => ({
    originServicePointId,
    destinationServicePointId,
    departureAt: INSTANT('2026-09-24T02:41:00.000Z'),
    estimatedArrivalAt: INSTANT('2026-09-24T02:50:29.000Z'),
    trafficProfile: 'NORMAL',
    distanceMeters: 1000,
    durationSeconds: 600,
    farePolicyId: policyId,
    pricingCode: TEST_CODE,
    pricingVersion: 1,
    currency: 'BDT',
    baseFare: '10.00',
    distanceFare: '1.00',
    timeFare: '1.00',
    preTrafficSubtotal: '12.00',
    trafficMultiplier: '1.000000',
    trafficAdjustment: '0.00',
    minimumFare: '0.00',
    minimumFareApplied: false,
    finalFare: '12.00',
    routeSnapshot: { edges: [] },
    fareBreakdown: { rounding: { scale: 2, mode: 'HALF_UP' } },
    createdAt: INSTANT('2026-09-24T02:41:00.000Z'),
    expiresAt: INSTANT('2026-09-24T02:46:00.000Z'),
    ...overrides,
  });

  it('refuses to re-price a version a quote refers to, and says what to do instead', async () => {
    const policy = await pool.farePolicy.create({ data: policyData({ version: 4 }) });
    const quote = await pool.fareQuote.create({ data: quoteData(policy.id) });

    try {
      await withRollback(async (tx) => {
        const err = await expectPgError(
          tx,
          () => tx.farePolicy.update({ where: { id: policy.id }, data: { baseFare: '99.00' } }),
          '23514',
        );
        assert.match(err.message, /create a new version/);

        // Every calculation input is frozen, not just the headline rate.
        for (const data of [
          { perKilometerRate: '99.00' },
          { perMinuteRate: '99.00' },
          { minimumFare: '99.00' },
          { normalTrafficMultiplier: '2.0000' },
          { rushHourMultiplier: '2.0000' },
          { roundingScale: 0 },
          { currency: 'USD' },
          { version: 5 },
          { code: 'something-else' },
        ]) {
          await expectPgError(
            tx,
            () => tx.farePolicy.update({ where: { id: policy.id }, data }),
            '23514',
          );
        }
      });

      // Operational metadata is still editable: retiring a version, renaming it
      // or shortening the TTL of future quotes changes no historical number.
      await withRollback(async (tx) => {
        await tx.farePolicy.update({
          where: { id: policy.id },
          data: {
            name: 'Renamed',
            active: false,
            effectiveTo: INSTANT('2030-01-01T00:00:00.000Z'),
            quoteTtlSeconds: 600,
          },
        });
      });
    } finally {
      await pool.fareQuote.delete({ where: { id: quote.id } });
      await pool.farePolicy.delete({ where: { id: policy.id } });
    }
  });

  it('allows an unquoted version to be re-priced', async () => {
    const policy = await pool.farePolicy.create({ data: policyData({ version: 5 }) });

    try {
      await withRollback(async (tx) => {
        const updated = await tx.farePolicy.update({
          where: { id: policy.id },
          data: { baseFare: '99.00' },
        });
        assert.strictEqual(updated.baseFare.toString(), '99');
      });
    } finally {
      await pool.farePolicy.delete({ where: { id: policy.id } });
    }
  });
});

describe('fare quotes as stored evidence', () => {
  it('refuses an UPDATE outright', async () => {
    const policy = await pool.farePolicy.create({ data: policyData({ version: 6 }) });
    const quote = await pool.fareQuote.create({
      data: {
        originServicePointId,
        destinationServicePointId,
        departureAt: INSTANT('2026-09-24T02:41:00.000Z'),
        estimatedArrivalAt: INSTANT('2026-09-24T02:50:29.000Z'),
        trafficProfile: 'NORMAL',
        distanceMeters: 1000,
        durationSeconds: 600,
        farePolicyId: policy.id,
        pricingCode: TEST_CODE,
        pricingVersion: 6,
        currency: 'BDT',
        baseFare: '10.00',
        distanceFare: '1.00',
        timeFare: '1.00',
        preTrafficSubtotal: '12.00',
        trafficMultiplier: '1.000000',
        trafficAdjustment: '0.00',
        minimumFare: '0.00',
        minimumFareApplied: false,
        finalFare: '12.00',
        routeSnapshot: {},
        fareBreakdown: {},
        createdAt: INSTANT('2026-09-24T02:41:00.000Z'),
        expiresAt: INSTANT('2026-09-24T02:46:00.000Z'),
      },
    });

    try {
      await withRollback(async (tx) => {
        for (const data of [{ finalFare: '0.00' }, { distanceMeters: 1 }, { routeSnapshot: {} }]) {
          const err = await expectPgError(
            tx,
            () => tx.fareQuote.update({ where: { id: quote.id }, data }),
            '23514',
          );
          assert.match(err.message, /immutable/);
        }
      });
    } finally {
      await pool.fareQuote.delete({ where: { id: quote.id } });
      await pool.farePolicy.delete({ where: { id: policy.id } });
    }
  });

  const rejectQuote = (overrides, sqlState = '23514') =>
    withRollback(async (tx) => {
      const policy = await tx.farePolicy.create({ data: policyData({ version: 7 }) });

      await expectPgError(
        tx,
        () =>
          tx.fareQuote.create({
            data: {
              originServicePointId,
              destinationServicePointId,
              departureAt: INSTANT('2026-09-24T02:41:00.000Z'),
              estimatedArrivalAt: INSTANT('2026-09-24T02:50:29.000Z'),
              trafficProfile: 'NORMAL',
              distanceMeters: 1000,
              durationSeconds: 600,
              farePolicyId: policy.id,
              pricingCode: TEST_CODE,
              pricingVersion: 7,
              currency: 'BDT',
              baseFare: '10.00',
              distanceFare: '1.00',
              timeFare: '1.00',
              preTrafficSubtotal: '12.00',
              trafficMultiplier: '1.000000',
              trafficAdjustment: '0.00',
              minimumFare: '0.00',
              minimumFareApplied: false,
              finalFare: '12.00',
              routeSnapshot: {},
              fareBreakdown: {},
              createdAt: INSTANT('2026-09-24T02:41:00.000Z'),
              expiresAt: INSTANT('2026-09-24T02:46:00.000Z'),
              ...overrides,
            },
          }),
        sqlState,
      );
    });

  it('refuses a breakdown that does not add up', async () => {
    await rejectQuote({ preTrafficSubtotal: '13.00' });
  });

  it('refuses a total that is neither the minimum nor the adjusted subtotal', async () => {
    await rejectQuote({ finalFare: '11.00' });
  });

  it('refuses a minimum-fare flag that disagrees with the arithmetic', async () => {
    await rejectQuote({ minimumFareApplied: true });
  });

  it('refuses the same service point on both ends', async () => {
    await rejectQuote({ destinationServicePointId: originServicePointId });
  });

  it('refuses an expiry that is not after creation', async () => {
    await rejectQuote({ expiresAt: INSTANT('2026-09-24T02:41:00.000Z') });
  });

  it('refuses a non-positive distance or duration', async () => {
    await rejectQuote({ distanceMeters: 0 });
    await rejectQuote({ durationSeconds: 0 });
  });

  it('refuses an arrival before the departure', async () => {
    await rejectQuote({ estimatedArrivalAt: INSTANT('2026-09-24T02:00:00.000Z') });
  });

  it('refuses a quote for a policy that does not exist', async () => {
    await rejectQuote({ farePolicyId: '00000000-0000-0000-0000-000000000000' }, '23503');
  });
});
