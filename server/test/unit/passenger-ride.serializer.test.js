import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import {
  toCurrentRideDto,
  toCurrentRideEnvelope,
  toRideDetailDto,
  toRideHistoryDto,
  toRideSummaryDto,
} from '../../src/serializers/passenger-ride.serializer.js';

/**
 * The passenger's ride DTOs.
 *
 * The assertions are about the boundary: a passenger is shown their own journey
 * and nothing that could name, address or price another person. Every fixture here
 * carries the fields a *co-passenger's* row would carry if the query were wrong, so
 * a serializer that started reading them would fail these tests rather than leak.
 */

const money = (value) => new Prisma.Decimal(value);

/** Everything `SUMMARY_SELECT` reads for one matched request. */
const REQUEST = {
  id: 'aaaaaaaa-1111-1111-1111-111111111111',
  status: 'MATCHED',
  requestedAt: new Date('2026-09-25T12:17:06.592Z'),
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  searchExpiresAt: new Date('2026-09-25T12:27:06.592Z'),
  cancellationReason: null,
  currency: 'BDT',
  acceptedFare: money('130.630000'),
  acceptedPricingCode: 'dhaka-solo',
  acceptedPricingVersion: 1,
  acceptedDistanceMeters: 2214,
  acceptedDurationSeconds: 569,
  pickupServicePoint: { id: 'p1', code: 'banani-road-11', name: 'Banani Road 11' },
  dropoffServicePoint: { id: 'p2', code: 'mohakhali-bus-terminal', name: 'Mohakhali Bus Terminal' },
  fareQuote: { fareBreakdown: { roundingScale: 2 } },
  poolMember: {
    id: 'bbbbbbbb-1111-1111-1111-111111111111',
    status: 'ASSIGNED',
    matchedAt: new Date('2026-09-25T12:17:06.902Z'),
    pickedUpAt: null,
    droppedOffAt: null,
    ridePool: {
      id: 'cccccccc-1111-1111-1111-111111111111',
      status: 'DRIVER_EN_ROUTE',
      capacitySnapshot: 3,
      plannedDistanceMeters: money('2214.00'),
      plannedDurationSeconds: 569,
      departedAt: new Date('2026-09-25T12:17:07.382Z'),
      completedAt: null,
      vehicle: { name: 'Bullet', seatCapacity: 3 },
      driverProfile: { user: { name: 'Jashim Uddin' } },
      _count: { members: 1 },
    },
  },
};

/** The allocation the fare query returns for one request. */
const FARE = {
  rideRequestId: REQUEST.id,
  finalFare: money('126.630000'),
  acceptedSoloFare: money('130.630000'),
  currency: 'BDT',
  fareCalculation: {
    status: 'FINALIZED',
    poolVersion: 1,
    finalizedAt: new Date('2026-09-25T12:17:07.382Z'),
    pricingPolicy: { roundingScale: 2 },
  },
};

const STOP = {
  id: 'dddddddd-1111-1111-1111-111111111111',
  sequence: 1,
  stopType: 'PICKUP',
  status: 'ARRIVED',
  plannedArrivalAt: new Date('2026-09-25T12:19:00.902Z'),
  actualArrivalAt: new Date('2026-09-25T12:17:07.486Z'),
  completedAt: null,
  servicePoint: { code: 'banani-road-11', name: 'Banani Road 11' },
};

describe('toRideSummaryDto', () => {
  it('returns exactly the documented fields', () => {
    assert.deepStrictEqual(
      Object.keys(toRideSummaryDto({ request: REQUEST, fare: FARE })).sort(),
      [
        'cancellable',
        'cancelledAt',
        'completedAt',
        'destination',
        'driver',
        'passengerCount',
        'pickup',
        'requestedAt',
        'rideRequestId',
        'route',
        'sharedFare',
        'soloEstimate',
        'startedAt',
        'status',
        'vehicle',
      ],
    );
  });

  it('reports the money as exact decimal strings, never as numbers', () => {
    const dto = toRideSummaryDto({ request: REQUEST, fare: FARE });

    assert.strictEqual(dto.soloEstimate.fare, '130.63');
    assert.strictEqual(dto.sharedFare.fare, '126.63');
    assert.strictEqual(typeof dto.soloEstimate.fare, 'string');
  });

  it('reports no shared fare as null rather than as zero', () => {
    const dto = toRideSummaryDto({ request: { ...REQUEST, poolMember: null }, fare: null });

    assert.strictEqual(dto.sharedFare, null);
    assert.strictEqual(dto.driver, null);
    assert.strictEqual(dto.vehicle, null);
    assert.strictEqual(dto.passengerCount, null);
  });

  it('gives the driver a first name and no identifier', () => {
    const dto = toRideSummaryDto({ request: REQUEST, fare: FARE });

    assert.deepStrictEqual(dto.driver, { displayName: 'Jashim' });
    assert.deepStrictEqual(Object.keys(dto.driver), ['displayName']);
  });

  it('reports the passenger count as an aggregate, without the rows behind it', () => {
    const dto = toRideSummaryDto({ request: REQUEST, fare: FARE });

    assert.strictEqual(dto.passengerCount, 1);
    assert.strictEqual(dto.passengerCount !== undefined, true);
    // There is no array of passengers anywhere in the payload, so a count cannot
    // be unpacked into a person.
    assert.doesNotMatch(JSON.stringify(dto), /members|passengerProfile|passengers/);
  });

  it('never exposes a fingerprint, an idempotency key or another passenger', () => {
    const dto = toRideSummaryDto({
      request: {
        ...REQUEST,
        requestFingerprint: 'secret-fingerprint',
        idempotencyKey: 'secret-key',
        passengerProfileId: 'eeeeeeee-1111-1111-1111-111111111111',
      },
      fare: FARE,
    });

    const payload = JSON.stringify(dto);
    assert.doesNotMatch(payload, /secret/);
    assert.doesNotMatch(payload, /passengerProfileId|acceptedSoloFare|previousPooledFareCap/);
  });

  it('marks the fare final only when the calculation was frozen', () => {
    const estimated = toRideSummaryDto({
      request: REQUEST,
      fare: { ...FARE, fareCalculation: { ...FARE.fareCalculation, status: 'CURRENT' } },
    });

    assert.strictEqual(toRideSummaryDto({ request: REQUEST, fare: FARE }).sharedFare.finalized, true);
    assert.strictEqual(estimated.sharedFare.finalized, false);
  });
});

describe('toCurrentRideDto', () => {
  it('returns exactly the documented fields', () => {
    assert.deepStrictEqual(
      Object.keys(toCurrentRideDto({ request: REQUEST, fare: FARE, stops: [STOP] })).sort(),
      [
        'cancellable',
        'cancelledAt',
        'completedAt',
        'destination',
        'driver',
        'memberStatus',
        'myStops',
        'nextAction',
        'passengerCount',
        'pickup',
        'pool',
        'requestedAt',
        'rideRequestId',
        'route',
        'searchExpiresAt',
        'sharedFare',
        'soloEstimate',
        'stage',
        'startedAt',
        'status',
        'timeline',
        'vehicle',
      ],
    );
  });

  it('walks the stage and the next action together', () => {
    const pickup = (overrides) => ({ ...STOP, ...overrides });

    // Matched, nobody has set off.
    const assigned = toCurrentRideDto({
      request: { ...REQUEST, poolMember: { ...REQUEST.poolMember, ridePool: { ...REQUEST.poolMember.ridePool, departedAt: null } } },
      fare: FARE,
    });
    assert.strictEqual(assigned.stage, 'DRIVER_ASSIGNED');
    assert.strictEqual(assigned.nextAction, 'WAIT_FOR_DRIVER');

    // Departed.
    assert.strictEqual(
      toCurrentRideDto({ request: REQUEST, fare: FARE }).nextAction,
      'WATCH_DRIVER',
    );

    // At the passenger's own pickup.
    const arrived = toCurrentRideDto({ request: REQUEST, fare: FARE, stops: [pickup({})] });
    assert.strictEqual(arrived.stage, 'DRIVER_ARRIVED');
    assert.strictEqual(arrived.nextAction, 'BOARD_VEHICLE');

    // In the car, trip not started.
    const aboard = toCurrentRideDto({
      request: {
        ...REQUEST,
        poolMember: { ...REQUEST.poolMember, pickedUpAt: new Date('2026-09-25T12:17:07.607Z') },
      },
      fare: FARE,
      stops: [pickup({ status: 'COMPLETED', completedAt: new Date() })],
    });
    assert.strictEqual(aboard.stage, 'PICKED_UP');
    assert.strictEqual(aboard.nextAction, 'IN_RIDE');
  });

  it('reports the passenger\'s own stops, in order', () => {
    const dto = toCurrentRideDto({
      request: REQUEST,
      fare: FARE,
      stops: [
        { ...STOP, id: 'second', sequence: 2, stopType: 'DROPOFF' },
        { ...STOP, id: 'first', sequence: 1 },
      ],
    });

    // The service sorts by sequence; the serializer trusts it and does not
    // reorder, so the contract is "whatever order they were read in".
    assert.deepStrictEqual(dto.myStops.map((stop) => stop.sequence), [2, 1]);
    assert.deepStrictEqual(Object.keys(dto.myStops[0]).sort(), [
      'actualArrivalAt',
      'completedAt',
      'plannedArrivalAt',
      'sequence',
      'servicePoint',
      'status',
      'stopId',
      'stopType',
    ]);
  });

  it('nests the pool as status-only facts', () => {
    const dto = toCurrentRideDto({ request: REQUEST, fare: FARE, stops: [STOP] });

    assert.deepStrictEqual(dto.pool, {
      poolId: 'cccccccc-1111-1111-1111-111111111111',
      status: 'DRIVER_EN_ROUTE',
      completedAt: null,
    });
  });

  it('answers an empty envelope for a passenger with no ride', () => {
    assert.deepStrictEqual(toCurrentRideEnvelope(null), { ride: null });
  });
});

describe('toRideDetailDto', () => {
  it('returns exactly the documented fields', () => {
    assert.deepStrictEqual(
      Object.keys(
        toRideDetailDto({ request: REQUEST, fare: FARE, stops: [STOP], events: [] }),
      ).sort(),
      [
        'cancellable',
        'cancelledAt',
        'completedAt',
        'destination',
        'driver',
        'member',
        'memberStatus',
        'myStops',
        'nextAction',
        'passengerCount',
        'pickup',
        'pool',
        'requestedAt',
        'rideRequestId',
        'route',
        'searchExpiresAt',
        'sharedFare',
        'sharedRoute',
        'soloEstimate',
        'stage',
        'startedAt',
        'status',
        'timeline',
        'vehicle',
      ],
    );
  });

  it('maps the timeline for a passenger and drops the dispatch events', () => {
    const dto = toRideDetailDto({
      request: REQUEST,
      fare: FARE,
      stops: [STOP],
      events: [
        { id: 'a', sequence: 1, eventType: 'RIDE_REQUESTED', actorType: 'PASSENGER', createdAt: new Date() },
        { id: 'b', sequence: 2, eventType: 'DRIVER_OFFERED', actorType: 'SYSTEM', createdAt: new Date() },
        { id: 'c', sequence: 3, eventType: 'PASSENGER_PICKED_UP', actorType: 'DRIVER', createdAt: new Date() },
      ],
    });

    assert.deepStrictEqual(
      dto.timeline.map((entry) => entry.eventType),
      ['RIDE_REQUESTED', 'PASSENGER_PICKED_UP'],
    );
    assert.strictEqual(dto.timeline[0].label, 'Ride requested');
  });

  it('reports the passenger\'s own member state', () => {
    const dto = toRideDetailDto({ request: REQUEST, fare: FARE, stops: [STOP], events: [] });

    assert.strictEqual(dto.member.memberStatus, 'ASSIGNED');
    assert.strictEqual(dto.memberStatus, 'ASSIGNED');
    assert.strictEqual(dto.member.droppedOffAt, null);
  });

  it('reports the pool as counts, capacity and a completion instant', () => {
    const dto = toRideDetailDto({ request: REQUEST, fare: FARE, stops: [STOP], events: [] });

    assert.deepStrictEqual(Object.keys(dto.pool).sort(), [
      'capacity',
      'completedAt',
      'passengerCount',
      'poolId',
      'status',
    ]);
  });

  it('reports the planned route once matched, and null before', () => {
    const matched = toRideDetailDto({ request: REQUEST, fare: FARE, stops: [STOP], events: [] });
    const unmatched = toRideDetailDto({
      request: { ...REQUEST, poolMember: null },
      fare: null,
      stops: [],
      events: [],
    });

    assert.deepStrictEqual(matched.sharedRoute, { distanceMeters: 2214, durationSeconds: 569 });
    assert.strictEqual(unmatched.sharedRoute, null);
    assert.strictEqual(unmatched.pool, null);
    assert.strictEqual(unmatched.member, null);
    assert.strictEqual(unmatched.memberStatus, null);
  });
});

describe('toRideHistoryDto', () => {
  it('reports a page and its pagination', () => {
    const dto = toRideHistoryDto({
      rides: [{ request: REQUEST, fare: FARE }],
      total: 57,
      limit: 20,
      offset: 20,
    });

    assert.strictEqual(dto.data.length, 1);
    assert.deepStrictEqual(dto.pagination, {
      limit: 20,
      offset: 20,
      returned: 1,
      total: 57,
      hasMore: true,
    });
  });

  it('answers an empty page with hasMore false', () => {
    const dto = toRideHistoryDto({ rides: [], total: 0, limit: 20, offset: 0 });

    assert.deepStrictEqual(dto.data, []);
    assert.strictEqual(dto.pagination.hasMore, false);
  });

  it('says hasMore is false on exactly the last page', () => {
    const dto = toRideHistoryDto({
      rides: [{ request: REQUEST, fare: FARE }],
      total: 21,
      limit: 20,
      offset: 20,
    });

    assert.strictEqual(dto.pagination.hasMore, false);
  });
});
