import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toCurrentUserDto } from '../../src/serializers/user.serializer.js';

/**
 * The serializer is the boundary between a database record and a response, so
 * these tests are mostly about what must NOT appear: the password hash, audit
 * timestamps, the login identifier, and any profile that does not belong to the
 * user's role.
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

const PASSENGER = {
  id: 'u1',
  name: 'Nusrat',
  email: 'nusrat@example.com',
  role: 'PASSENGER',
  active: true,
  passwordHash: '$2b$10$this-must-never-be-returned',
  createdAt: new Date(),
  updatedAt: new Date(),
  lastLoginAt: new Date(),
  passengerProfile: { id: 'p1', userId: 'u1' },
  driverProfile: null,
};

const DRIVER = {
  ...PASSENGER,
  id: 'u2',
  name: 'Jashim',
  role: 'DRIVER',
  passengerProfile: null,
  driverProfile: {
    id: 'd1',
    userId: 'u2',
    status: 'OFFLINE',
    createdAt: new Date(),
    vehicles: [
      { id: 'v1', driverId: 'd1', name: 'Bullet', seatCapacity: 3, active: true, createdAt: new Date() },
    ],
  },
};

describe('toCurrentUserDto', () => {
  it('never exposes the password hash, audit timestamps or the login identifier', () => {
    for (const user of [PASSENGER, DRIVER]) {
      const keys = allKeys(toCurrentUserDto(user));

      assert.ok(!keys.includes('passwordHash'), 'passwordHash leaked');
      assert.ok(!keys.some((key) => /password/i.test(key)), 'a password field leaked');
      assert.ok(!keys.includes('password_hash'), 'password_hash leaked');
      assert.ok(!keys.includes('createdAt'), 'createdAt leaked');
      assert.ok(!keys.includes('updatedAt'), 'updatedAt leaked');
      assert.ok(!keys.includes('lastLoginAt'), 'lastLoginAt leaked');
      assert.ok(!keys.includes('email'), 'the login identifier leaked');
    }
  });

  it('returns the passenger profile, and no driver profile, for a passenger', () => {
    const dto = toCurrentUserDto(PASSENGER);

    assert.deepStrictEqual(dto, {
      id: 'u1',
      name: 'Nusrat',
      role: 'PASSENGER',
      active: true,
      passengerProfile: { id: 'p1' },
    });
    assert.ok(!('driverProfile' in dto));
  });

  it('returns the driver profile and vehicle summary, and no passenger profile, for a driver', () => {
    const dto = toCurrentUserDto(DRIVER);

    assert.deepStrictEqual(dto, {
      id: 'u2',
      name: 'Jashim',
      role: 'DRIVER',
      active: true,
      driverProfile: {
        id: 'd1',
        status: 'OFFLINE',
        vehicles: [{ id: 'v1', name: 'Bullet', seatCapacity: 3 }],
      },
    });
    assert.ok(!('passengerProfile' in dto));
  });

  it('returns no profile at all for an admin', () => {
    const dto = toCurrentUserDto({ ...PASSENGER, role: 'ADMIN', passengerProfile: null });

    assert.deepStrictEqual(dto, { id: 'u1', name: 'Nusrat', role: 'ADMIN', active: true });
  });

  it('does not expose a profile that does not match the role', () => {
    // A driver profile on an admin account is inconsistent data; it must not be
    // surfaced just because it happens to be loaded.
    const dto = toCurrentUserDto({ ...DRIVER, role: 'ADMIN' });

    assert.ok(!('driverProfile' in dto));
    assert.ok(!('passengerProfile' in dto));
  });

  it('uses null when the expected profile is missing', () => {
    assert.strictEqual(toCurrentUserDto({ ...PASSENGER, passengerProfile: null }).passengerProfile, null);
    assert.strictEqual(toCurrentUserDto({ ...DRIVER, driverProfile: null }).driverProfile, null);
  });

  it('reports an inactive account as inactive', () => {
    assert.strictEqual(toCurrentUserDto({ ...PASSENGER, active: false }).active, false);
  });
});
