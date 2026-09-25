import assert from 'node:assert/strict';

import { prisma } from '../../src/db/prisma.js';
import * as driverService from '../../src/services/driver.service.js';
import { hashPassword } from '../../src/utils/password.js';
import { pool } from './db.js';

/**
 * Fixtures shared by the driver, dispatch and pool suites.
 *
 * The demo seed has exactly one driver (Jashim), which is not enough to test
 * dispatch: relevance, ordering, fallback after a refusal and "two drivers
 * cannot accept one request" all need a *second* driver, and the "a stale
 * location makes a driver ineligible" case needs a driver who can be moved far
 * away. So this module creates and removes drivers of its own rather than
 * changing the demo cast, which other suites assert on.
 */

/** Seeded service points, with their distance from the Banani Road 11 pickup. */
export const POINTS = Object.freeze({
  /** The pickup used by most tests. */
  PICKUP: 'banani-road-11',
  DESTINATION: 'mohakhali-bus-terminal',
  /** 445 m from the pickup: inside the default 3 km shortlist. */
  NEAR: 'banani-kakoli',
  /** 1068 m from the pickup: also inside. */
  MID: 'gulshan-2-circle',
  /** 3911 m from the pickup: outside the 3 km shortlist, inside 8 km. */
  FAR: 'mirpur-10',
  /** 9.7 km away, and unreachable without going the wrong way down one-ways. */
  UNREACHABLE: 'khamarbari',
});

/** Loads the demo cast the way the services expect to receive it. */
export const loadDemoUser = (email) =>
  prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      passengerProfile: { select: { id: true } },
      driverProfile: {
        select: {
          id: true,
          status: true,
          currentServicePointId: true,
          availableSince: true,
          lastSeenAt: true,
          activeVehicleId: true,
          vehicles: {
            where: { active: true },
            select: { id: true, name: true, seatCapacity: true },
            orderBy: { name: 'asc' },
          },
        },
      },
    },
  });

/** Finds a seeded service point and asserts it is really there. */
export const servicePointId = async (code) => {
  const point = await prisma.servicePoint.findUnique({ where: { code }, select: { id: true } });
  assert.ok(point, `the seed must contain service point ${code}`);
  return point.id;
};

/**
 * Creates a driver with one vehicle, so a suite can have more than one
 * candidate. The email is unique per call, and the returned object is the same
 * shape `loadDemoUser` returns, so the services accept it unchanged.
 */
export const createTestDriver = async ({
  name = 'Test Driver',
  email,
  password,
  vehicleName = 'Test Car',
  seatCapacity = 3,
} = {}) => {
  const address = email ?? `dispatch-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

  await prisma.user.create({
    data: {
      name,
      email: address,
      role: 'DRIVER',
      active: true,
      // A real hash, so a suite can sign the fixture in through the actual
      // authentication rather than around it.
      passwordHash: password ? await hashPassword(password) : null,
      driverProfile: {
        create: {
          status: 'OFFLINE',
          vehicles: { create: { name: vehicleName, seatCapacity, active: true } },
        },
      },
    },
    select: { id: true },
  });

  return loadDemoUser(address);
};

/**
 * Removes a driver created by `createTestDriver`, with their vehicle.
 *
 * Their pools go first: `ride_pools.driver_profile_id` is `ON DELETE RESTRICT`
 * (a pool is a commitment, and the database will not let the driver vanish from
 * under it), so deleting the user directly fails while a pool exists -- which is
 * how a fixture leaks between runs.
 */
export const removeTestDriver = async (email) => {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, driverProfile: { select: { id: true } } },
  });

  if (!user) return;

  if (user.driverProfile) {
    await pool.query(`DELETE FROM dispatch_offers WHERE driver_profile_id = $1::uuid`, [
      user.driverProfile.id,
    ]);
    await pool.query(`DELETE FROM ride_pools WHERE driver_profile_id = $1::uuid`, [
      user.driverProfile.id,
    ]);
  }

  await prisma.user.deleteMany({ where: { email } });
};

/** Puts a driver online at `code` through the real service. */
export const goOnline = (driver, code, extra = {}) =>
  driverService.goOnline({ driver, currentServicePointCode: code, ...extra });

/** Takes a driver offline through the real service, ignoring state errors. */
export const goOfflineQuietly = async (driver) => {
  try {
    return await driverService.goOffline({ driver });
  } catch {
    return null;
  }
};

/**
 * Returns every driver to a known OFFLINE state with no reservations.
 *
 * Dispatch is a shared-state feature: a driver left AVAILABLE by one test is a
 * candidate for the next one's ride request, and a driver left RESERVED blocks
 * their own tests. Suites call this before each test rather than trusting what
 * came before.
 */
export const resetDrivers = async () => {
  await pool.query(
    `UPDATE driver_profiles
        SET status = 'OFFLINE',
            current_service_point_id = NULL,
            available_since = NULL,
            last_seen_at = NULL,
            active_vehicle_id = NULL`,
  );
};

/**
 * Clears every ride, offer and pool, in the order the foreign keys require:
 * offers first (they point at pools and requests), then pools (which cascade to
 * members, stops and pool events), then requests (which cascade to ride events).
 */
export const resetRides = async () => {
  await pool.query(`DELETE FROM dispatch_offers`);
  await pool.query(`DELETE FROM ride_pools`);
  await pool.query(`DELETE FROM ride_requests`);
};

/**
 * Puts every vehicle back to active.
 *
 * A test that deactivates a vehicle to prove it excludes a driver must not leave
 * it that way: the next test would fail with "needs an active vehicle" for a
 * reason that has nothing to do with what it is testing.
 */
export const resetVehicles = () => pool.query(`UPDATE vehicles SET active = true`);

/**
 * Both resets plus the vehicles: the state a dispatch test starts from.
 */
export const resetDispatchState = async () => {
  await resetRides();
  await resetDrivers();
  await resetVehicles();
};

/**
 * Runs `fn` with part of `env` temporarily overridden, then restores it.
 *
 * Thresholds are configuration -- `env` is a plain object read at call time, not
 * a frozen constant -- so a test can prove a limit is enforced by setting it to
 * something impossible, without a second process or a rebuilt module.
 *
 *     await withEnv(env.dispatch, { maxApproachDurationSeconds: 1 }, () => ...)
 */
export const withEnv = async (target, overrides, fn) => {
  const original = { ...target };
  Object.assign(target, overrides);

  try {
    return await fn();
  } finally {
    Object.assign(target, original);
  }
};
