import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { toPoolDto } from '../../src/serializers/pool.serializer.js';

/**
 * The driver's view of the pool they accepted.
 *
 * The assertions are about the boundary: a driver is told who they are
 * collecting and where, and nothing else. No passenger identity beyond a display
 * name, no money, no quote id, no route geometry, no other driver.
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

const POOL = {
  id: 'aaaaaaaa-1111-1111-1111-111111111111',
  status: 'FORMING',
  version: 1,
  capacitySnapshot: 3,
  plannedDistanceMeters: new Prisma.Decimal('2214.00'),
  plannedDurationSeconds: 569,
  createdAt: new Date('2026-09-25T03:01:40.645Z'),
  acceptedAt: new Date('2026-09-25T03:01:40.645Z'),
  driverArrivedAt: null,
  departedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  // The fare, for its status only: the DTO says whether it is settled, never what
  // it is worth.
  fareCalculations: [
    {
      id: '99999999-1111-1111-1111-111111111111',
      status: 'CURRENT',
      poolVersion: 1,
      finalizedAt: null,
    },
  ],
  vehicle: { name: 'Bullet', seatCapacity: 3 },
  members: [
    {
      id: 'bbbbbbbb-1111-1111-1111-111111111111',
      status: 'ASSIGNED',
      matchedAt: new Date('2026-09-25T03:01:40.645Z'),
      pickedUpAt: null,
      droppedOffAt: null,
      rideRequestId: 'cccccccc-1111-1111-1111-111111111111',
      rideRequest: {
        id: 'cccccccc-1111-1111-1111-111111111111',
        status: 'MATCHED',
        pickupServicePoint: { code: 'banani-road-11', name: 'Banani Road 11' },
        dropoffServicePoint: { code: 'mohakhali-bus-terminal', name: 'Mohakhali Bus Terminal' },
        passengerProfile: { user: { name: 'Nusrat Jahan' } },
      },
    },
  ],
  stops: [
    {
      id: 'dddddddd-1111-1111-1111-111111111111',
      sequence: 2,
      stopType: 'DROPOFF',
      status: 'PENDING',
      plannedArrivalAt: new Date('2026-09-25T03:13:03.645Z'),
      actualArrivalAt: null,
      completedAt: null,
      servicePoint: { code: 'mohakhali-bus-terminal', name: 'Mohakhali Bus Terminal' },
      poolMemberId: 'bbbbbbbb-1111-1111-1111-111111111111',
    },
    {
      id: 'eeeeeeee-1111-1111-1111-111111111111',
      sequence: 1,
      stopType: 'PICKUP',
      status: 'PENDING',
      plannedArrivalAt: new Date('2026-09-25T03:03:34.645Z'),
      actualArrivalAt: null,
      completedAt: null,
      servicePoint: { code: 'banani-road-11', name: 'Banani Road 11' },
      poolMemberId: 'bbbbbbbb-1111-1111-1111-111111111111',
    },
  ],
  events: [
    {
      id: 'ffffffff-1111-1111-1111-111111111111',
      sequence: 1,
      eventType: 'POOL_CREATED',
      actorType: 'DRIVER',
      createdAt: new Date('2026-09-25T03:01:40.645Z'),
    },
    {
      id: 'ffffffff-2222-2222-2222-222222222222',
      sequence: 2,
      eventType: 'MEMBER_ADDED',
      actorType: 'DRIVER',
      createdAt: new Date('2026-09-25T03:01:40.645Z'),
    },
  ],
};

describe('toPoolDto', () => {
  it('returns exactly the documented fields', () => {
    assert.deepStrictEqual(Object.keys(toPoolDto(POOL)).sort(), [
      'acceptedAt',
      'allowedActions',
      'cancelledAt',
      'capacity',
      'completedAt',
      'departedAt',
      'driverArrivedAt',
      'events',
      'members',
      'nextStop',
      'plan',
      'poolId',
      'pricing',
      'startedAt',
      'status',
      'stops',
      'vehicle',
      'version',
    ]);
  });

  it('tells the driver what they may do next, and where', () => {
    const dto = toPoolDto(POOL);

    // A forming pool with a plan can depart, and nothing else: there is no stop
    // to reach yet.
    assert.deepStrictEqual(dto.allowedActions, ['DEPART']);
    // The next actionable stop is the lowest-sequence one that is not done, which
    // is the pickup -- even though the rows arrived drop-off first.
    assert.strictEqual(dto.nextStop.stopId, 'eeeeeeee-1111-1111-1111-111111111111');
    assert.strictEqual(dto.nextStop.stopType, 'PICKUP');

    // `nextStop` is a whole stop, and the same one as in `stops` -- not a
    // rule-shaped stub. Asserting only its id and type let a bug through where it
    // carried `servicePoint: null` while the identical row in `stops` named the
    // place, so the two are compared field by field here.
    assert.deepStrictEqual(
      dto.nextStop,
      dto.stops.find((stop) => stop.stopId === dto.nextStop.stopId),
      'the next stop must be the same stop the plan lists, in full',
    );
    assert.strictEqual(dto.nextStop.servicePoint.code, 'banani-road-11');
    assert.strictEqual(dto.nextStop.plannedArrivalAt, '2026-09-25T03:03:34.645Z');

    assert.deepStrictEqual(
      dto.stops.map((stop) => stop.sequence),
      [1, 2],
      'the plan is reported in the order it is driven',
    );

    // The fare status travels with the pool; the amounts never do.
    assert.deepStrictEqual(dto.pricing, {
      finalized: false,
      finalizedAt: null,
      poolVersion: 1,
    });
  });

  it('offers no action at all once the pool is finished', () => {
    const finished = {
      ...POOL,
      status: 'COMPLETED',
      departedAt: new Date('2026-09-25T03:02:00.000Z'),
      driverArrivedAt: new Date('2026-09-25T03:03:00.000Z'),
      startedAt: new Date('2026-09-25T03:04:00.000Z'),
      completedAt: new Date('2026-09-25T03:20:00.000Z'),
      fareCalculations: [
        { id: '99999999-1111-1111-1111-111111111111', status: 'FINALIZED', poolVersion: 1, finalizedAt: new Date('2026-09-25T03:02:00.000Z') },
      ],
      members: [
        {
          ...POOL.members[0],
          status: 'DROPPED_OFF',
          pickedUpAt: new Date('2026-09-25T03:05:00.000Z'),
          droppedOffAt: new Date('2026-09-25T03:20:00.000Z'),
          rideRequest: { ...POOL.members[0].rideRequest, status: 'COMPLETED' },
        },
      ],
      stops: POOL.stops.map((stop) => ({
        ...stop,
        status: 'COMPLETED',
        actualArrivalAt: new Date('2026-09-25T03:04:00.000Z'),
        completedAt: new Date('2026-09-25T03:20:00.000Z'),
      })),
    };

    const dto = toPoolDto(finished);

    assert.deepStrictEqual(dto.allowedActions, []);
    assert.strictEqual(dto.nextStop, null);
    assert.strictEqual(dto.pricing.finalized, true);
  });

  it('reports the plan, the vehicle and the capacity the pool was built with', () => {
    const dto = toPoolDto(POOL);

    assert.strictEqual(dto.poolId, POOL.id);
    assert.strictEqual(dto.status, 'FORMING');
    assert.strictEqual(dto.version, 1);
    assert.strictEqual(dto.capacity, 3);
    assert.deepStrictEqual(dto.vehicle, { name: 'Bullet', seatCapacity: 3 });
    assert.deepStrictEqual(dto.plan, { distanceMeters: 2214, durationSeconds: 569, stopCount: 2 });
  });

  it('returns the plan distance as a number, not as a decimal string', () => {
    // Distances are measurements, not money: money stays a decimal string
    // everywhere, a metre count does not have to be.
    assert.strictEqual(typeof toPoolDto(POOL).plan.distanceMeters, 'number');
  });

  it('never exposes a fare, a quote, a fingerprint or another passenger?s identity', () => {
    const keys = allKeys(toPoolDto(POOL));
    const serialized = JSON.stringify(toPoolDto(POOL));

    for (const forbidden of [
      'fare',
      'fareQuoteId',
      'currency',
      'acceptedFare',
      'requestFingerprint',
      'idempotencyKey',
      'passengerProfileId',
      'userId',
      'email',
      'phone',
      'password',
      'score',
      'geometry',
      'driverProfileId',
    ]) {
      assert.ok(!keys.includes(forbidden), `the DTO must not contain ${forbidden}`);
      assert.ok(!serialized.includes(forbidden), `the payload must not mention ${forbidden}`);
    }
  });

  it('gives the driver a display name and no more', () => {
    const dto = toPoolDto(POOL);

    assert.deepStrictEqual(dto.members[0].passenger, { displayName: 'Nusrat' });
    assert.ok(!JSON.stringify(dto).includes('Nusrat Jahan'));
  });

  it('nests each member?s stops in the order they happen', () => {
    const member = toPoolDto(POOL).members[0];

    assert.deepStrictEqual(
      member.stops.map((stop) => [stop.sequence, stop.stopType, stop.servicePoint.code]),
      [
        [1, 'PICKUP', 'banani-road-11'],
        [2, 'DROPOFF', 'mohakhali-bus-terminal'],
      ],
    );
    assert.deepStrictEqual(Object.keys(member.stops[0]).sort(), [
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

  it('places the stops on the member they belong to and on no other member', () => {
    const other = {
      ...POOL.members[0],
      id: 'bbbbbbbb-9999-9999-9999-999999999999',
      rideRequestId: 'cccccccc-9999-9999-9999-999999999999',
    };
    const dto = toPoolDto({ ...POOL, members: [POOL.members[0], other] });

    assert.strictEqual(dto.members[0].stops.length, 2);
    assert.deepStrictEqual(dto.members[1].stops, []);
  });

  it('includes the pool history, which belongs to the driver too', () => {
    const dto = toPoolDto(POOL);

    assert.deepStrictEqual(
      dto.events.map((event) => [event.sequence, event.eventType, event.actorType]),
      [
        [1, 'POOL_CREATED', 'DRIVER'],
        [2, 'MEMBER_ADDED', 'DRIVER'],
      ],
    );
  });

  it('returns null for no pool rather than an empty object', () => {
    assert.strictEqual(toPoolDto(null), null);
  });

  it('reports a not-yet-reached stop with null actual arrival', () => {
    const stop = toPoolDto(POOL).members[0].stops[0];

    assert.strictEqual(stop.actualArrivalAt, null);
    assert.strictEqual(stop.plannedArrivalAt, '2026-09-25T03:03:34.645Z');
    assert.strictEqual(stop.status, 'PENDING');
  });
});
