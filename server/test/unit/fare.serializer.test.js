import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { toFareQuoteDto } from '../../src/serializers/fare.serializer.js';

/**
 * The quote DTO.
 *
 * The fixture is shaped like a row Prisma returns: `numeric` columns arrive as
 * Decimal, timestamps as Date, JSONB as a plain object. Money is asserted as an
 * exact string, because the whole point of the money format is that `"166.28"`
 * survives the trip to a client while `166.28` would not.
 */

const quote = (overrides = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  departureAt: new Date('2026-09-24T02:41:00.000Z'),
  estimatedArrivalAt: new Date('2026-09-24T02:50:29.000Z'),
  trafficProfile: 'RUSH_HOUR',
  distanceMeters: 2214,
  durationSeconds: 569,
  currency: 'BDT',
  pricingCode: 'dhaka-solo',
  pricingVersion: 1,
  baseFare: new Prisma.Decimal('40.000000'),
  distanceFare: new Prisma.Decimal('59.780000'),
  timeFare: new Prisma.Decimal('18.970000'),
  preTrafficSubtotal: new Prisma.Decimal('118.750000'),
  trafficMultiplier: new Prisma.Decimal('1.100000'),
  trafficAdjustment: new Prisma.Decimal('11.880000'),
  minimumFare: new Prisma.Decimal('80.000000'),
  minimumFareApplied: false,
  finalFare: new Prisma.Decimal('130.630000'),
  expiresAt: new Date('2026-09-24T02:46:00.000Z'),
  routeSnapshot: { edges: [{ edgeCode: 'edge-a-to-b', fareWeight: '1.500' }] },
  fareBreakdown: { rounding: { scale: 2, mode: 'HALF_UP' } },
  ...overrides,
});

const origin = { code: 'banani-road-11', name: 'Banani Road 11' };
const destination = { code: 'mohakhali-bus-terminal', name: 'Mohakhali Bus Terminal' };

const dto = (overrides) =>
  toFareQuoteDto({ quote: quote(overrides), origin, destination });

describe('toFareQuoteDto', () => {
  it('returns exactly the documented fields', () => {
    assert.deepStrictEqual(Object.keys(dto()).sort(), [
      'departureAt',
      'destination',
      'estimatedArrivalAt',
      'expiresAt',
      'fare',
      'origin',
      'quoteId',
      'route',
      'trafficProfile',
    ]);

    assert.deepStrictEqual(Object.keys(dto().fare).sort(), [
      'baseFare',
      'currency',
      'distanceFare',
      'finalFare',
      'minimumFareApplied',
      'preTrafficSubtotal',
      'pricingCode',
      'pricingVersion',
      'timeFare',
      'trafficAdjustment',
      'trafficMultiplier',
    ]);

    assert.deepStrictEqual(Object.keys(dto().route).sort(), [
      'distanceKilometers',
      'distanceMeters',
      'durationMinutes',
      'durationSeconds',
    ]);
  });

  it('returns money as exact two-decimal strings', () => {
    const fare = dto().fare;

    assert.strictEqual(fare.baseFare, '40.00');
    assert.strictEqual(fare.distanceFare, '59.78');
    assert.strictEqual(fare.timeFare, '18.97');
    assert.strictEqual(fare.preTrafficSubtotal, '118.75');
    assert.strictEqual(fare.trafficAdjustment, '11.88');
    assert.strictEqual(fare.finalFare, '130.63');
    assert.strictEqual(fare.currency, 'BDT');
    assert.strictEqual(fare.pricingCode, 'dhaka-solo');
    assert.strictEqual(fare.pricingVersion, 1);
    assert.strictEqual(fare.minimumFareApplied, false);
  });

  it('formats every money field as a decimal string, never a number', () => {
    const fare = dto().fare;

    for (const [field, value] of Object.entries(fare)) {
      if (field === 'currency' || field === 'pricingCode' || field === 'pricingVersion') continue;
      if (field === 'minimumFareApplied') {
        assert.strictEqual(typeof value, 'boolean');
        continue;
      }
      assert.strictEqual(typeof value, 'string', `${field} must be a string`);
      assert.match(value, /^\d+\.\d{2}$/, `${field} must be a two-decimal amount`);
    }

    assert.strictEqual(fare.trafficMultiplier, '1.10');
  });

  it('formats kilometres and minutes as strings, without float noise', () => {
    const route = dto().route;

    assert.strictEqual(route.distanceMeters, 2214);
    assert.strictEqual(route.distanceKilometers, '2.214');
    assert.strictEqual(route.durationSeconds, 569);
    assert.strictEqual(route.durationMinutes, '9.48');
  });

  it('returns UTC ISO timestamps', () => {
    const result = dto();

    assert.strictEqual(result.departureAt, '2026-09-24T02:41:00.000Z');
    assert.strictEqual(result.estimatedArrivalAt, '2026-09-24T02:50:29.000Z');
    assert.strictEqual(result.expiresAt, '2026-09-24T02:46:00.000Z');
  });

  it('names the endpoints and identifies the quote', () => {
    const result = dto();

    assert.strictEqual(result.quoteId, '11111111-1111-4111-8111-111111111111');
    assert.deepStrictEqual(result.origin, { code: 'banani-road-11', name: 'Banani Road 11' });
    assert.deepStrictEqual(result.destination, {
      code: 'mohakhali-bus-terminal',
      name: 'Mohakhali Bus Terminal',
    });
  });

  it('does not leak the audit trail, the rate card, or anything pooled', () => {
    const serialized = JSON.stringify(dto());

    for (const forbidden of [
      'routeSnapshot',
      'fareBreakdown',
      'perKilometerRate',
      'perMinuteRate',
      'minimumFare"',
      'fareWeight',
      'graph_edge_id',
      'graphEdgeId',
      'pool',
      'discount',
      'surge',
      'ride',
      'passenger',
      'userId',
      'password',
    ]) {
      assert.ok(
        !serialized.includes(forbidden),
        `the quote response must not contain ${forbidden}`,
      );
    }
  });

  it('presents money at the scale the quote recorded', () => {
    const result = toFareQuoteDto({
      quote: quote({
        baseFare: new Prisma.Decimal('41'),
        distanceFare: new Prisma.Decimal('0'),
        timeFare: new Prisma.Decimal('0'),
        preTrafficSubtotal: new Prisma.Decimal('41'),
        trafficAdjustment: new Prisma.Decimal('0'),
        finalFare: new Prisma.Decimal('41'),
        fareBreakdown: { rounding: { scale: 0, mode: 'HALF_UP' } },
      }),
      origin,
      destination,
    });

    assert.strictEqual(result.fare.finalFare, '41');
    assert.strictEqual(result.fare.preTrafficSubtotal, '41');
  });

  it('falls back to two decimals when the stored rule is unreadable', () => {
    // A quote that exists should still be returnable, so an unexpected scale
    // degrades to the default rather than throwing.
    for (const fareBreakdown of [null, {}, { rounding: {} }, { rounding: { scale: 'two' } }, { rounding: { scale: 99 } }]) {
      const result = dto({ fareBreakdown });
      assert.strictEqual(result.fare.finalFare, '130.63');
    }
  });

  it('does not mutate or alias the row it is given', () => {
    const row = quote();
    const result = toFareQuoteDto({ quote: row, origin, destination });

    result.fare.baseFare = '0.00';
    assert.strictEqual(row.baseFare.toString(), '40');
  });
});
