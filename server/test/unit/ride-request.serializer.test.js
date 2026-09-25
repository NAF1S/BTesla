import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import {
  toRideRequestDto,
  toRideRequestListDto,
} from '../../src/serializers/ride-request.serializer.js';

/**
 * The passenger's view of a ride request.
 *
 * These tests are mostly about what must NOT be in the payload -- the
 * fingerprint, the passenger identifiers, the quote's internal breakdown, the
 * rate cards -- and about money staying exact. A leak here is permanent: a
 * response is the one part of the system a client can store forever.
 */

/** Every key appearing anywhere in the payload, at any depth. */
const allKeys = (value, found = []) => {
  if (value === null || typeof value !== 'object') return found;

  for (const [key, child] of Object.entries(value)) {
    found.push(key);
    allKeys(child, found);
  }
  return found;
};

const ROW = {
  id: '99999999-9999-9999-9999-999999999999',
  passengerProfileId: '11111111-1111-1111-1111-111111111111',
  fareQuoteId: '22222222-2222-2222-2222-222222222222',
  pickupServicePointId: '33333333-3333-3333-3333-333333333333',
  dropoffServicePointId: '44444444-4444-4444-4444-444444444444',
  status: 'WAITING',
  requestedAt: new Date('2026-09-24T02:41:30.000Z'),
  searchExpiresAt: new Date('2026-09-24T02:51:30.000Z'),
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  idempotencyKey: 'probe-key-0001',
  requestFingerprint: 'f'.repeat(64),
  acceptedFare: new Prisma.Decimal('130.63'),
  currency: 'BDT',
  acceptedPricingCode: 'dhaka-solo',
  acceptedPricingVersion: 1,
  acceptedDistanceMeters: 2214,
  acceptedDurationSeconds: 569,
  pickupServicePoint: { code: 'banani-road-11', name: 'Banani Road 11' },
  dropoffServicePoint: { code: 'mohakhali-bus-terminal', name: 'Mohakhali Bus Terminal' },
  fareQuote: { fareBreakdown: { rounding: { scale: 2 } } },
};

describe('toRideRequestDto', () => {
  it('returns exactly the documented fields', () => {
    assert.deepStrictEqual(Object.keys(toRideRequestDto(ROW)).sort(), [
      'acceptedQuote',
      'cancellable',
      'cancellationReason',
      'cancelledAt',
      'completedAt',
      'destination',
      'id',
      'pickup',
      'requestedAt',
      'searchExpiresAt',
      'startedAt',
      'status',
      'trip',
    ]);

    assert.deepStrictEqual(Object.keys(toRideRequestDto(ROW).acceptedQuote).sort(), [
      'currency',
      'distanceMeters',
      'durationSeconds',
      'fare',
      'fareQuoteId',
      'pricingCode',
      'pricingVersion',
    ]);

    assert.deepStrictEqual(Object.keys(toRideRequestDto(ROW).pickup).sort(), ['code', 'name']);
    assert.deepStrictEqual(Object.keys(toRideRequestDto(ROW).destination).sort(), ['code', 'name']);
  });

  it('carries no trip until the caller has loaded one', () => {
    // The history page does not read the pool, the member and the timeline of
    // every row, so the key is there and empty rather than missing: a client can
    // tell "no trip" from "not asked for".
    assert.strictEqual(toRideRequestDto(ROW).trip, null);

    const trip = toRideRequestDto(ROW, {
      trip: {
        member: {
          id: 'member-1',
          status: 'PICKED_UP',
          matchedAt: new Date('2026-09-24T02:42:00.000Z'),
          pickedUpAt: new Date('2026-09-24T02:50:00.000Z'),
          droppedOffAt: null,
        },
        pool: {
          id: 'pool-1',
          status: 'IN_PROGRESS',
          departedAt: new Date('2026-09-24T02:45:00.000Z'),
          driverArrivedAt: new Date('2026-09-24T02:49:00.000Z'),
          startedAt: new Date('2026-09-24T02:52:00.000Z'),
          completedAt: null,
          vehicle: { name: 'Bullet', seatCapacity: 3 },
          driverProfile: { user: { name: 'Jashim Uddin' } },
        },
        stops: [
          {
            id: 'stop-1',
            sequence: 1,
            stopType: 'PICKUP',
            status: 'COMPLETED',
            plannedArrivalAt: new Date('2026-09-24T02:49:00.000Z'),
            actualArrivalAt: new Date('2026-09-24T02:49:30.000Z'),
            completedAt: new Date('2026-09-24T02:50:00.000Z'),
            servicePoint: { code: 'banani-road-11', name: 'Banani Road 11' },
          },
        ],
        events: [
          {
            sequence: 5,
            eventType: 'PASSENGER_PICKED_UP',
            actorType: 'SYSTEM',
            createdAt: new Date('2026-09-24T02:50:00.000Z'),
          },
        ],
      },
    });

    assert.deepStrictEqual(Object.keys(trip.trip).sort(), [
      'driver',
      'events',
      'memberStatus',
      'nextStop',
      'poolId',
      'poolStatus',
      'stage',
      'stops',
      'timeline',
      'vehicle',
    ]);

    assert.strictEqual(trip.trip.stage, 'PICKED_UP');
    assert.strictEqual(trip.trip.driver.displayName, 'Jashim', 'a first name is all a driver gets too');
    assert.deepStrictEqual(Object.keys(trip.trip.timeline).sort(), [
      'departedAt',
      'driverArrivedAt',
      'droppedOffAt',
      'matchedAt',
      'pickedUpAt',
    ]);

    // The events a passenger is given carry no metadata: the payloads name pools,
    // offers and drivers.
    for (const event of trip.trip.events) {
      assert.deepStrictEqual(Object.keys(event).sort(), [
        'actorType',
        'createdAt',
        'eventType',
        'sequence',
      ]);
    }
  });

  it('never exposes the fingerprint, the passenger, the key, or the quote internals', () => {
    const keys = allKeys(toRideRequestDto(ROW));
    const serialized = JSON.stringify(toRideRequestDto(ROW));

    for (const forbidden of [
      'requestFingerprint',
      'idempotencyKey',
      'passengerProfileId',
      'passengerId',
      'userId',
      'fareBreakdown',
      'rounding',
      'fareWeight',
      'baseFare',
      'perKilometerRate',
      'routeSnapshot',
    ]) {
      assert.ok(!keys.includes(forbidden), `the DTO must not contain ${forbidden}`);
      assert.ok(!serialized.includes(forbidden), `the payload must not mention ${forbidden}`);
    }

    // The 64 character digest must not survive anywhere in the body.
    assert.ok(!serialized.includes(ROW.requestFingerprint));
    assert.ok(!serialized.includes(ROW.idempotencyKey));
    assert.ok(!serialized.includes(ROW.passengerProfileId));
  });

  it('exposes the quote the fare was accepted from, without the route snapshot', () => {
    const dto = toRideRequestDto(ROW);

    assert.strictEqual(dto.acceptedQuote.fareQuoteId, ROW.fareQuoteId);
    assert.strictEqual(dto.acceptedQuote.currency, 'BDT');
    assert.strictEqual(dto.acceptedQuote.pricingCode, 'dhaka-solo');
    assert.strictEqual(dto.acceptedQuote.pricingVersion, 1);
    assert.strictEqual(dto.acceptedQuote.distanceMeters, 2214);
    assert.strictEqual(dto.acceptedQuote.durationSeconds, 569);
  });

  it('returns the accepted fare as an exact decimal string', () => {
    const dto = toRideRequestDto(ROW);

    assert.strictEqual(typeof dto.acceptedQuote.fare, 'string');
    assert.strictEqual(dto.acceptedQuote.fare, '130.63');
  });

  it('formats the money at the scale recorded on the quote, not at a fixed two', () => {
    const three = toRideRequestDto({
      ...ROW,
      acceptedFare: new Prisma.Decimal('130.625'),
      fareQuote: { fareBreakdown: { rounding: { scale: 3 } } },
    });
    assert.strictEqual(three.acceptedQuote.fare, '130.625');

    // An absent or nonsensical scale falls back to the project default of two
    // decimals rather than throwing: a request that exists must still be returned.
    for (const fareQuote of [null, {}, { fareBreakdown: {} }, { fareBreakdown: { rounding: {} } }]) {
      const fallback = toRideRequestDto({
        ...ROW,
        acceptedFare: new Prisma.Decimal('130.625'),
        fareQuote,
      });
      assert.strictEqual(fallback.acceptedQuote.fare, '130.63');
    }
  });

  it('returns timestamps as UTC ISO strings', () => {
    const dto = toRideRequestDto(ROW);

    assert.strictEqual(dto.requestedAt, '2026-09-24T02:41:30.000Z');
    assert.strictEqual(dto.searchExpiresAt, '2026-09-24T02:51:30.000Z');
  });

  it('reports a waiting request as cancellable, with no cancellation recorded', () => {
    const dto = toRideRequestDto(ROW);

    assert.strictEqual(dto.status, 'WAITING');
    assert.strictEqual(dto.cancellable, true);
    assert.strictEqual(dto.cancelledAt, null);
    assert.strictEqual(dto.cancellationReason, null);
  });

  it('derives cancellable from the status rather than from stored columns', () => {
    for (const status of ['WAITING']) {
      assert.strictEqual(toRideRequestDto({ ...ROW, status }).cancellable, true, status);
    }

    for (const status of ['MATCHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED']) {
      assert.strictEqual(toRideRequestDto({ ...ROW, status }).cancellable, false, status);
    }
  });

  it('reports a cancelled request with its reason and no longer cancellable', () => {
    const dto = toRideRequestDto({
      ...ROW,
      status: 'CANCELLED',
      cancelledAt: new Date('2026-09-24T02:45:00.000Z'),
      cancellationReason: 'WAIT_TOO_LONG',
    });

    assert.strictEqual(dto.cancellable, false);
    assert.strictEqual(dto.cancelledAt, '2026-09-24T02:45:00.000Z');
    assert.strictEqual(dto.cancellationReason, 'WAIT_TOO_LONG');
  });

  it('reports an expired request with the reason slot still empty', () => {
    const dto = toRideRequestDto({ ...ROW, status: 'EXPIRED' });

    assert.strictEqual(dto.cancellable, false);
    assert.strictEqual(dto.cancelledAt, null);
    assert.strictEqual(dto.cancellationReason, null);
  });

  it('names the endpoints by code and human-readable name', () => {
    const dto = toRideRequestDto(ROW);

    assert.deepStrictEqual(dto.pickup, { code: 'banani-road-11', name: 'Banani Road 11' });
    assert.deepStrictEqual(dto.destination, {
      code: 'mohakhali-bus-terminal',
      name: 'Mohakhali Bus Terminal',
    });
  });
});

describe('toRideRequestListDto', () => {
  it('returns the page with a pagination block a client can page with', () => {
    const dto = toRideRequestListDto({
      requests: [ROW],
      total: 3,
      limit: 2,
      offset: 0,
    });

    assert.deepStrictEqual(Object.keys(dto).sort(), ['data', 'pagination']);
    assert.strictEqual(dto.data.length, 1);
    assert.deepStrictEqual(dto.pagination, {
      limit: 2,
      offset: 0,
      returned: 1,
      total: 3,
      hasMore: true,
    });
  });

  it('reports hasMore as false on the last page', () => {
    const dto = toRideRequestListDto({ requests: [ROW], total: 3, limit: 2, offset: 2 });

    assert.strictEqual(dto.pagination.returned, 1);
    assert.strictEqual(dto.pagination.hasMore, false);
  });

  it('returns an empty page rather than null when the passenger has no history', () => {
    const dto = toRideRequestListDto({ requests: [], total: 0, limit: 20, offset: 0 });

    assert.deepStrictEqual(dto.data, []);
    assert.deepStrictEqual(dto.pagination, {
      limit: 20,
      offset: 0,
      returned: 0,
      total: 0,
      hasMore: false,
    });
  });

  it('serializes each row through the same whitelist', () => {
    const dto = toRideRequestListDto({ requests: [ROW, { ...ROW, id: 'other' }], total: 9, limit: 20, offset: 0 });

    assert.strictEqual(dto.data[1].id, 'other');
    for (const item of dto.data) {
      assert.deepStrictEqual(Object.keys(item).sort(), Object.keys(toRideRequestDto(ROW)).sort());
    }
  });
});
