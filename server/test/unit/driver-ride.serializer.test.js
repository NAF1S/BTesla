import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import {
  toDriverRideDetailDto,
  toDriverRideHistoryDto,
  toDriverRideSummaryDto,
} from '../../src/serializers/driver-ride.serializer.js';

/**
 * The driver's ride-history DTOs.
 *
 * Two properties are asserted throughout, and they pull in opposite directions:
 * a driver must be told everything they need to operate the ride (who, where, in
 * what order), and nothing that belongs to a passenger's account — no id, no
 * credential, and above all no per-passenger fare.
 */

const money = (value) => new Prisma.Decimal(value);

const STOP = (sequence, stopType, status, overrides = {}) => ({
  id: `stop-${sequence}`,
  sequence,
  stopType,
  status,
  poolMemberId: 'bbbbbbbb-1111-1111-1111-111111111111',
  plannedArrivalAt: new Date('2026-09-25T12:19:00.902Z'),
  actualArrivalAt: null,
  completedAt: null,
  servicePoint: { code: 'banani-road-11', name: 'Banani Road 11' },
  ...overrides,
});

const POOL = {
  id: 'cccccccc-1111-1111-1111-111111111111',
  status: 'COMPLETED',
  version: 1,
  capacitySnapshot: 3,
  plannedDistanceMeters: money('2214.00'),
  plannedDurationSeconds: 569,
  createdAt: new Date('2026-09-25T12:17:06.902Z'),
  acceptedAt: new Date('2026-09-25T12:17:06.902Z'),
  departedAt: new Date('2026-09-25T12:17:07.382Z'),
  driverArrivedAt: new Date('2026-09-25T12:17:07.486Z'),
  startedAt: new Date('2026-09-25T12:17:07.709Z'),
  completedAt: new Date('2026-09-25T12:17:08.017Z'),
  cancelledAt: null,
  vehicle: { id: 'veh-1', name: 'Bullet', seatCapacity: 3 },
  _count: { members: 1, stops: 2 },
  fareCalculations: [
    {
      id: 'calc-1',
      status: 'FINALIZED',
      poolVersion: 1,
      currency: 'BDT',
      totalFinalPassengerFare: money('126.630000'),
      createdAt: new Date('2026-09-25T12:17:07.382Z'),
      finalizedAt: new Date('2026-09-25T12:17:07.382Z'),
      pricingPolicy: { roundingScale: 2 },
    },
  ],
  members: [
    {
      id: 'bbbbbbbb-1111-1111-1111-111111111111',
      status: 'DROPPED_OFF',
      matchedAt: new Date('2026-09-25T12:17:06.902Z'),
      pickedUpAt: new Date('2026-09-25T12:17:07.607Z'),
      droppedOffAt: new Date('2026-09-25T12:17:07.895Z'),
      rideRequest: {
        id: 'aaaaaaaa-1111-1111-1111-111111111111',
        status: 'COMPLETED',
        pickupServicePoint: { code: 'banani-road-11', name: 'Banani Road 11' },
        dropoffServicePoint: { code: 'mohakhali-bus-terminal', name: 'Mohakhali Bus Terminal' },
        passengerProfile: {
          user: { name: 'Nusrat Jahan', email: 'nusrat@example.com' },
        },
      },
    },
  ],
  stops: [
    STOP(1, 'PICKUP', 'COMPLETED', { actualArrivalAt: new Date(), completedAt: new Date() }),
    STOP(2, 'DROPOFF', 'COMPLETED', {
      actualArrivalAt: new Date(),
      completedAt: new Date(),
      servicePoint: { code: 'mohakhali-bus-terminal', name: 'Mohakhali Bus Terminal' },
    }),
  ],
};

describe('toDriverRideSummaryDto', () => {
  it('returns exactly the documented fields', () => {
    const stops = POOL.stops;

    assert.deepStrictEqual(
      Object.keys(
        toDriverRideSummaryDto({
          pool: POOL,
          firstStop: stops[0],
          finalStop: stops[1],
          completedStops: 2,
        }),
      ).sort(),
      [
        'acceptedAt',
        'completedAt',
        'completedStopCount',
        'createdAt',
        'fare',
        'finalServicePoint',
        'firstServicePoint',
        'passengerCount',
        'poolId',
        'route',
        'status',
        'stopCount',
        'vehicle',
      ],
    );
  });

  it('reports where the trip began and ended, from its own stops', () => {
    const dto = toDriverRideSummaryDto({
      pool: POOL,
      firstStop: POOL.stops[0],
      finalStop: POOL.stops[1],
      completedStops: 2,
    });

    assert.deepStrictEqual(dto.firstServicePoint, {
      code: 'banani-road-11',
      name: 'Banani Road 11',
    });
    assert.deepStrictEqual(dto.finalServicePoint, {
      code: 'mohakhali-bus-terminal',
      name: 'Mohakhali Bus Terminal',
    });
    assert.strictEqual(dto.route.distanceMeters, 2214, 'a number, not a decimal string');
  });

  it('reports counts rather than the rows behind them', () => {
    const dto = toDriverRideSummaryDto({
      pool: POOL,
      firstStop: POOL.stops[0],
      finalStop: POOL.stops[1],
      completedStops: 1,
    });

    assert.strictEqual(dto.passengerCount, 1);
    assert.strictEqual(dto.stopCount, 2);
    assert.strictEqual(dto.completedStopCount, 1);
    assert.doesNotMatch(JSON.stringify(dto), /Nusrat|passengers|members/);
  });

  it('reports the pool fare as a total, with no way to attribute it to a person', () => {
    const dto = toDriverRideSummaryDto({
      pool: POOL,
      firstStop: POOL.stops[0],
      finalStop: POOL.stops[1],
      completedStops: 2,
    });

    assert.deepStrictEqual(Object.keys(dto.fare).sort(), [
      'currency',
      'fareStatus',
      'finalized',
      'finalizedAt',
      'poolVersion',
      'totalPassengerFare',
    ]);
    assert.strictEqual(dto.fare.totalPassengerFare, '126.63');
    assert.strictEqual(dto.fare.finalized, true);
  });

  it('omits the fare entirely when the plan has no calculation', () => {
    const dto = toDriverRideSummaryDto({
      pool: { ...POOL, fareCalculations: [] },
      firstStop: POOL.stops[0],
      finalStop: POOL.stops[1],
      completedStops: 2,
    });

    assert.strictEqual(dto.fare, null);
  });

  it('reports a pool with no stops without inventing places', () => {
    const dto = toDriverRideSummaryDto({
      pool: { ...POOL, stops: [], _count: { members: 0, stops: 0 } },
      firstStop: null,
      finalStop: null,
      completedStops: 0,
    });

    assert.strictEqual(dto.firstServicePoint, null);
    assert.strictEqual(dto.finalServicePoint, null);
    assert.strictEqual(dto.passengerCount, 0);
  });
});

describe('toDriverRideDetailDto', () => {
  const detail = () => toDriverRideDetailDto({ pool: POOL, events: [] });

  it('returns exactly the documented fields', () => {
    assert.deepStrictEqual(Object.keys(detail()).sort(), [
      'acceptedAt',
      'allowedActions',
      'cancelledAt',
      'capacity',
      'completedAt',
      'createdAt',
      'departedAt',
      'driverArrivedAt',
      'fare',
      'nextStop',
      'passengerCount',
      'passengers',
      'poolId',
      'route',
      'startedAt',
      'status',
      'stops',
      'timeline',
      'vehicle',
      'version',
    ]);
  });

  it('orders the stops the way they are driven, whatever order they were read in', () => {
    const dto = toDriverRideDetailDto({
      pool: { ...POOL, stops: [POOL.stops[1], POOL.stops[0]] },
      events: [],
    });

    assert.deepStrictEqual(dto.stops.map((stop) => stop.sequence), [1, 2]);
    assert.strictEqual(dto.stops[0].stopType, 'PICKUP');
  });

  it('gives a passenger a first name, their places, and nothing else', () => {
    const [passenger] = detail().passengers;

    assert.deepStrictEqual(Object.keys(passenger).sort(), [
      'displayName',
      'dropoff',
      'droppedOffAt',
      'matchedAt',
      'memberId',
      'memberStatus',
      'pickedUpAt',
      'pickup',
    ]);
    assert.strictEqual(passenger.displayName, 'Nusrat');

    // The fixture carries an email because a wrong `select` would return one.
    const payload = JSON.stringify(detail());
    assert.doesNotMatch(payload, /nusrat@example\.com/);
    assert.doesNotMatch(payload, /passengerProfile|passengerProfileId/);
  });

  it('carries no per-passenger fare', () => {
    const payload = JSON.stringify(detail());

    assert.doesNotMatch(payload, /acceptedFare|finalFare|allocations|allocation/);
    assert.doesNotMatch(payload, /allocatedLegCost|soloCapReduction/);
  });

  it('offers no action at all on a finished pool', () => {
    assert.deepStrictEqual(detail().allowedActions, []);
    assert.strictEqual(detail().nextStop, null);
  });

  it('offers the live pool the one action it can take', () => {
    // A pool that has departed and reached the first pickup may collect the
    // passenger waiting there -- and nothing else.
    const live = toDriverRideDetailDto({
      pool: {
        ...POOL,
        status: 'ARRIVED',
        completedAt: null,
        stops: [
          { ...POOL.stops[0], status: 'ARRIVED' },
          { ...POOL.stops[1], status: 'PENDING', actualArrivalAt: null, completedAt: null },
        ],
        members: [
          {
            ...POOL.members[0],
            status: 'ASSIGNED',
            rideRequest: { ...POOL.members[0].rideRequest, status: 'MATCHED' },
          },
        ],
      },
      events: [],
    });

    assert.deepStrictEqual(live.allowedActions, ['PICKUP_PASSENGER']);
    assert.strictEqual(live.nextStop.sequence, 1);
  });

  it('lets a driver start as soon as the passenger is aboard, before the drop-off is reached', () => {
    // The two things a driver standing at a completed pickup with their passenger
    // in the car may do: record reaching the next stop, or set off. Neither is
    // offered before the pickup is done, which the previous test pins.
    const aboard = toDriverRideDetailDto({
      pool: {
        ...POOL,
        status: 'ARRIVED',
        completedAt: null,
        stops: [
          { ...POOL.stops[0], status: 'COMPLETED' },
          { ...POOL.stops[1], status: 'PENDING', actualArrivalAt: null, completedAt: null },
        ],
        members: [
          {
            ...POOL.members[0],
            status: 'PICKED_UP',
            rideRequest: { ...POOL.members[0].rideRequest, status: 'MATCHED' },
          },
        ],
      },
      events: [],
    });

    assert.deepStrictEqual(aboard.allowedActions, ['ARRIVE_AT_STOP', 'START_TRIP']);
    assert.strictEqual(aboard.nextStop.sequence, 2);
  });

  it('does not offer to start a trip with no frozen fare to run under', () => {
    const unfrozen = toDriverRideDetailDto({
      pool: {
        ...POOL,
        status: 'ARRIVED',
        completedAt: null,
        fareCalculations: [],
        stops: [
          { ...POOL.stops[0], status: 'COMPLETED' },
          { ...POOL.stops[1], status: 'PENDING', actualArrivalAt: null, completedAt: null },
        ],
        members: [
          {
            ...POOL.members[0],
            status: 'PICKED_UP',
            rideRequest: { ...POOL.members[0].rideRequest, status: 'MATCHED' },
          },
        ],
      },
      events: [],
    });

    assert.strictEqual(unfrozen.fare, null);
    assert.deepStrictEqual(unfrozen.allowedActions, ['ARRIVE_AT_STOP']);
  });

  it('maps the pool timeline for a driver, dropping the reserved events', () => {
    const dto = toDriverRideDetailDto({
      pool: POOL,
      events: [
        { id: 'a', sequence: 1, eventType: 'POOL_CREATED', actorType: 'DRIVER', createdAt: new Date() },
        { id: 'b', sequence: 2, eventType: 'POOL_CANCELLED', actorType: 'SYSTEM', createdAt: new Date() },
        { id: 'c', sequence: 3, eventType: 'TRIP_COMPLETED', actorType: 'DRIVER', createdAt: new Date() },
      ],
    });

    assert.deepStrictEqual(
      dto.timeline.map((entry) => entry.eventType),
      ['POOL_CREATED', 'TRIP_COMPLETED'],
    );
    assert.strictEqual(dto.timeline[1].label, 'Trip completed');
  });
});

describe('toDriverRideHistoryDto', () => {
  it('reports a page and its pagination', () => {
    const dto = toDriverRideHistoryDto({
      rides: [
        { pool: POOL, firstStop: POOL.stops[0], finalStop: POOL.stops[1], completedStops: 2 },
      ],
      total: 5,
      limit: 20,
      offset: 0,
    });

    assert.strictEqual(dto.data.length, 1);
    assert.deepStrictEqual(dto.pagination, {
      limit: 20,
      offset: 0,
      returned: 1,
      total: 5,
      hasMore: true,
    });
  });

  it('answers an empty history with an empty page', () => {
    const dto = toDriverRideHistoryDto({ rides: [], total: 0, limit: 20, offset: 0 });

    assert.deepStrictEqual(dto.data, []);
    assert.strictEqual(dto.pagination.returned, 0);
  });
});
