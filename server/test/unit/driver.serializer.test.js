import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toDriverAvailabilityDto } from '../../src/serializers/driver.serializer.js';

/**
 * The driver's own availability.
 *
 * These tests are mostly about what must NOT appear -- the driver's user id, the
 * email they log in with, the internal dispatch state -- and about the two
 * derived flags a client uses to decide which button to show.
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

const PROFILE = {
  id: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  status: 'AVAILABLE',
  currentServicePointId: '33333333-3333-3333-3333-333333333333',
  availableSince: new Date('2026-09-25T03:00:00.000Z'),
  lastSeenAt: new Date('2026-09-25T03:01:00.000Z'),
  activeVehicleId: '44444444-4444-4444-4444-444444444444',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-25T03:01:00.000Z'),
  currentServicePoint: { code: 'banani-kakoli', name: 'Banani Kakoli' },
  activeVehicle: { id: '44444444-4444-4444-4444-444444444444', name: 'Bullet', seatCapacity: 3 },
  vehicles: [
    { id: '44444444-4444-4444-4444-444444444444', name: 'Bullet', seatCapacity: 3 },
  ],
};

describe('toDriverAvailabilityDto', () => {
  it('returns exactly the documented fields', () => {
    assert.deepStrictEqual(Object.keys(toDriverAvailabilityDto(PROFILE)).sort(), [
      'availableSince',
      'canGoOffline',
      'canGoOnline',
      'currentServicePoint',
      'driverProfileId',
      'lastSeenAt',
      'status',
      'updatedAt',
      'vehicle',
      'vehicles',
    ]);
  });

  it('never exposes the user id, the email or anything about another driver', () => {
    const keys = allKeys(toDriverAvailabilityDto(PROFILE));
    const serialized = JSON.stringify(toDriverAvailabilityDto(PROFILE));

    for (const forbidden of [
      'userId',
      'email',
      'passwordHash',
      'driverProfileId_other',
      'score',
      'candidate',
      'passenger',
    ]) {
      assert.ok(!keys.includes(forbidden), `the DTO must not contain ${forbidden}`);
      assert.ok(!serialized.includes(forbidden), `the payload must not mention ${forbidden}`);
    }

    assert.ok(!serialized.includes(PROFILE.userId));
    assert.ok(!serialized.includes(PROFILE.currentServicePointId));
  });

  it('reports where the driver is and what they are driving', () => {
    const dto = toDriverAvailabilityDto(PROFILE);

    assert.strictEqual(dto.driverProfileId, PROFILE.id);
    assert.strictEqual(dto.status, 'AVAILABLE');
    assert.deepStrictEqual(dto.currentServicePoint, { code: 'banani-kakoli', name: 'Banani Kakoli' });
    assert.deepStrictEqual(dto.vehicle, { vehicleId: PROFILE.activeVehicleId, name: 'Bullet', seatCapacity: 3 });
    assert.deepStrictEqual(dto.vehicles, [
      { vehicleId: PROFILE.activeVehicleId, name: 'Bullet', seatCapacity: 3 },
    ]);
  });

  it('returns timestamps as UTC ISO strings', () => {
    const dto = toDriverAvailabilityDto(PROFILE);

    assert.strictEqual(dto.availableSince, '2026-09-25T03:00:00.000Z');
    assert.strictEqual(dto.lastSeenAt, '2026-09-25T03:01:00.000Z');
    assert.strictEqual(dto.updatedAt, '2026-09-25T03:01:00.000Z');
  });

  it('derives the two flags from the status rather than storing them', () => {
    const expected = {
      OFFLINE: { canGoOnline: true, canGoOffline: false },
      AVAILABLE: { canGoOnline: true, canGoOffline: true },
      RESERVED: { canGoOnline: false, canGoOffline: false },
      ON_RIDE: { canGoOnline: false, canGoOffline: false },
    };

    for (const [status, flags] of Object.entries(expected)) {
      const dto = toDriverAvailabilityDto({ ...PROFILE, status });
      assert.deepStrictEqual(
        { canGoOnline: dto.canGoOnline, canGoOffline: dto.canGoOffline },
        flags,
        status,
      );
    }
  });

  it('reports an offline driver with no point and no vehicle as nulls, not as empty strings', () => {
    const dto = toDriverAvailabilityDto({
      ...PROFILE,
      status: 'OFFLINE',
      currentServicePoint: null,
      activeVehicle: null,
      availableSince: null,
      lastSeenAt: null,
      vehicles: [],
    });

    assert.strictEqual(dto.currentServicePoint, null);
    assert.strictEqual(dto.vehicle, null);
    assert.strictEqual(dto.availableSince, null);
    assert.strictEqual(dto.lastSeenAt, null);
    assert.deepStrictEqual(dto.vehicles, []);
    assert.strictEqual(dto.canGoOnline, true);
  });
});
