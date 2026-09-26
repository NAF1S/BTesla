import { env } from '../../config/env.js';
import { Prisma } from '@prisma/client';

import { FARE_POLICIES } from './fare.data.js';

/**
 * Idempotent seeder for the versioned solo-fare pricing policies.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WRITES, AND WHAT IT REFUSES TO
 * ---------------------------------------------------------------------------
 * For each policy in ./fare.data.js:
 *
 *   * if no row exists for (code, version), it is inserted;
 *   * if a row exists and **no quote references it**, it is updated to match the
 *     seed -- so iterating on demo rates before anybody has been quoted still
 *     works;
 *   * if a row exists and a quote *does* reference it, it is left completely
 *     alone. That is the whole point of versioning: a quoted price must stay
 *     reproducible, so changing a live rate means adding a new version, not
 *     rewriting history.
 *
 * The database backs this up independently: `prevent_referenced_fare_policy_change`
 * (07-fare-pricing.sql) refuses to change a calculation input on a referenced
 * policy even if this seeder -- or anything else -- tries.
 *
 * The returned summary distinguishes the three outcomes so a test can prove the
 * "left alone" case, which is the one that matters.
 *
 * Safe to run repeatedly, and never deletes a policy version.
 */

const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_ROUNDING_SCALE = 6;

/**
 * Money and multipliers must be decimal strings, never JavaScript numbers: a
 * `number` here would silently reintroduce binary floating point into pricing.
 */
const assertDecimalString = (value, label, { allowZero = true } = {}) => {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a decimal string such as "18.00", not a ${typeof value}`);
  }
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a non-negative decimal string, got "${value}"`);
  }

  const decimal = new Prisma.Decimal(value);
  if (!allowZero && decimal.isZero()) throw new Error(`${label} must be greater than zero`);

  return decimal;
};

/** Rejects malformed seed data before a single row is written. */
export const assertFareSeedDataIsCoherent = () => {
  const seen = new Set();

  if (FARE_POLICIES.length === 0) throw new Error('the fare seed must define at least one policy');

  for (const policy of FARE_POLICIES) {
    const label = `${policy.code} v${policy.version}`;

    if (!CODE_PATTERN.test(policy.code)) throw new Error(`Fare policy code "${policy.code}" is malformed`);
    if (!Number.isInteger(policy.version) || policy.version <= 0) {
      throw new Error(`Fare policy ${label} must have a positive integer version`);
    }

    const key = `${policy.code}|${policy.version}`;
    if (seen.has(key)) throw new Error(`Duplicate fare policy ${label}`);
    seen.add(key);

    if (typeof policy.name !== 'string' || policy.name.trim() === '') {
      throw new Error(`Fare policy ${label} must have a name`);
    }
    if (!CURRENCY_PATTERN.test(policy.currency) || policy.currency !== 'BDT') {
      throw new Error(`Fare policy ${label} must be priced in BDT`);
    }

    // Amounts may be zero (a free first kilometre is a legitimate configuration).
    assertDecimalString(policy.baseFare, `${label} baseFare`);
    assertDecimalString(policy.perKilometerRate, `${label} perKilometerRate`);
    assertDecimalString(policy.perMinuteRate, `${label} perMinuteRate`);
    assertDecimalString(policy.minimumFare, `${label} minimumFare`);
    // A multiplier of zero would make every ride free, so it is not allowed.
    assertDecimalString(policy.normalTrafficMultiplier, `${label} normalTrafficMultiplier`, {
      allowZero: false,
    });
    assertDecimalString(policy.rushHourMultiplier, `${label} rushHourMultiplier`, {
      allowZero: false,
    });

    if (!Number.isInteger(policy.quoteTtlSeconds) || policy.quoteTtlSeconds <= 0) {
      throw new Error(`Fare policy ${label} must have a positive quoteTtlSeconds`);
    }
    if (
      !Number.isInteger(policy.roundingScale) ||
      policy.roundingScale < 0 ||
      policy.roundingScale > MAX_ROUNDING_SCALE
    ) {
      throw new Error(`Fare policy ${label} must have a roundingScale between 0 and ${MAX_ROUNDING_SCALE}`);
    }

    // A charged fare is a whole number of `fareRoundingUnit`, so the unit is a
    // whole number of at least 1 -- and it has to divide `minimumFare`, or
    // rounding could snap a fare below the floor the minimum fare promises.
    const fareRoundingUnit = assertDecimalString(
      policy.fareRoundingUnit,
      `${label} fareRoundingUnit`,
      { allowZero: false },
    );
    if (!fareRoundingUnit.isInteger()) {
      throw new Error(`Fare policy ${label} must have a whole-number fareRoundingUnit`);
    }
    if (!new Prisma.Decimal(policy.minimumFare).div(fareRoundingUnit).isInteger()) {
      throw new Error(
        `Fare policy ${label} must have a minimumFare that is a whole number of its fareRoundingUnit`,
      );
    }

    const from = new Date(policy.effectiveFrom);
    if (Number.isNaN(from.getTime())) throw new Error(`Fare policy ${label} has an invalid effectiveFrom`);

    if (policy.effectiveTo !== null && policy.effectiveTo !== undefined) {
      const to = new Date(policy.effectiveTo);
      if (Number.isNaN(to.getTime())) throw new Error(`Fare policy ${label} has an invalid effectiveTo`);
      if (to.getTime() <= from.getTime()) {
        throw new Error(`Fare policy ${label} must end after it starts`);
      }
    }
  }
};

/** Every column the seeder owns, as Prisma input. */
const toPolicyData = (policy) => ({
  name: policy.name,
  currency: policy.currency,
  baseFare: policy.baseFare,
  perKilometerRate: policy.perKilometerRate,
  perMinuteRate: policy.perMinuteRate,
  minimumFare: policy.minimumFare,
  normalTrafficMultiplier: policy.normalTrafficMultiplier,
  rushHourMultiplier: policy.rushHourMultiplier,
  quoteTtlSeconds: policy.quoteTtlSeconds,
  roundingScale: policy.roundingScale,
  fareRoundingUnit: policy.fareRoundingUnit,
  active: policy.active ?? true,
  effectiveFrom: new Date(policy.effectiveFrom),
  effectiveTo: policy.effectiveTo ? new Date(policy.effectiveTo) : null,
});

/**
 * Applies the pricing seed with the given transaction client and reports what
 * happened to each version.
 */
export const seedFarePolicies = async (tx) => {
  if (env.nodeEnv === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error(
      'refusing to seed demo fare pricing when NODE_ENV=production (set ALLOW_DEMO_SEED=true to override)',
    );
  }

  assertFareSeedDataIsCoherent();

  const summary = { policies: FARE_POLICIES.length, created: 0, updated: 0, preserved: 0 };

  for (const policy of FARE_POLICIES) {
    const existing = await tx.farePolicy.findUnique({
      where: { code_version: { code: policy.code, version: policy.version } },
      select: { id: true },
    });

    if (existing) {
      const quoted = await tx.fareQuote.count({ where: { farePolicyId: existing.id } });

      if (quoted > 0) {
        // Frozen: it has been quoted, so its numbers are history now.
        summary.preserved += 1;
        continue;
      }

      await tx.farePolicy.update({ where: { id: existing.id }, data: toPolicyData(policy) });
      summary.updated += 1;
      continue;
    }

    await tx.farePolicy.create({
      data: { code: policy.code, version: policy.version, ...toPolicyData(policy) },
    });
    summary.created += 1;
  }

  return summary;
};
