import { Role } from '@prisma/client';

import { env } from '../../config/env.js';
import { hashPassword } from '../../utils/password.js';
import { normalizeEmail } from '../../utils/validation.js';
import { seedUsers, seedVehicles } from './auth.data.js';

/**
 * Idempotent, deterministic seeder for the demo identity data.
 *
 * Guarantees:
 *   * users are matched by normalised email, so re-running updates the demo
 *     accounts instead of duplicating them;
 *   * only the accounts listed in auth.data.js are touched -- a real user is
 *     never modified, and their password is never rewritten;
 *   * every seeded user ends up with exactly the profile its role requires;
 *   * it runs inside the caller's transaction, so a failure leaves nothing
 *     half-written (no PASSENGER without a PassengerProfile).
 *
 * Refuses to run in production unless ALLOW_DEMO_SEED=true, and even then
 * requires an explicit DEMO_SEED_PASSWORD.
 */

const ROLES = Object.values(Role);

const assertSeedAllowed = () => {
  if (!env.isProduction) return;

  if (!env.allowDemoSeed) {
    throw new Error(
      'refusing to seed demo accounts with NODE_ENV=production (set ALLOW_DEMO_SEED=true to override)',
    );
  }
  if (!process.env.DEMO_SEED_PASSWORD) {
    throw new Error(
      'DEMO_SEED_PASSWORD must be set explicitly when seeding demo accounts in production',
    );
  }
};

const assertSeedDataIsCoherent = () => {
  const emails = new Set();
  for (const user of seedUsers) {
    const email = normalizeEmail(user.email);
    if (emails.has(email)) throw new Error(`Duplicate seed user email "${email}"`);
    if (!ROLES.includes(user.role)) throw new Error(`Seed user "${email}" has unknown role "${user.role}"`);
    emails.add(email);
  }

  for (const vehicle of seedVehicles) {
    const driverEmail = normalizeEmail(vehicle.driverEmail);
    const driver = seedUsers.find((user) => normalizeEmail(user.email) === driverEmail);
    if (!driver) throw new Error(`Seed vehicle "${vehicle.name}" references unknown driver "${driverEmail}"`);
    if (driver.role !== Role.DRIVER) {
      throw new Error(`Seed vehicle "${vehicle.name}" requires "${driverEmail}" to be a DRIVER`);
    }
    if (!Number.isInteger(vehicle.seatCapacity) || vehicle.seatCapacity <= 0) {
      throw new Error(`Seed vehicle "${vehicle.name}" must have a positive integer seat capacity`);
    }
  }
};

/** Upserts one user and makes sure the profile matching its role exists. */
const upsertUser = async (tx, { name, email, role }, passwordHash) => {
  const normalizedEmail = normalizeEmail(email);

  const user = await tx.user.upsert({
    where: { email: normalizedEmail },
    update: { name, role, passwordHash, active: true },
    create: { name, email: normalizedEmail, role, passwordHash, active: true },
    select: { id: true },
  });

  // Exactly one profile, chosen by role; ADMIN gets none. The unique index on
  // user_id is what keeps this from ever producing a duplicate.
  if (role === Role.PASSENGER) {
    await tx.passengerProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
    });
  } else if (role === Role.DRIVER) {
    await tx.driverProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
    });
  }

  return user.id;
};

/** Upserts one vehicle against its driver profile. */
const upsertVehicle = async (tx, { driverEmail, name, seatCapacity, active = true }) => {
  const owner = await tx.user.findUnique({
    where: { email: normalizeEmail(driverEmail) },
    select: { driverProfile: { select: { id: true } } },
  });

  const driverId = owner?.driverProfile?.id;
  if (!driverId) {
    throw new Error(`Seed vehicle "${name}" requires "${driverEmail}" to exist as a DRIVER`);
  }

  // vehicles has no Prisma-visible unique key (its constraint is an expression
  // index on lower(btrim(name))), so this is find-then-write rather than an
  // upsert. The index still makes a duplicate impossible.
  const existing = await tx.vehicle.findFirst({
    where: { driverId, name },
    select: { id: true },
  });

  if (existing) {
    await tx.vehicle.update({ where: { id: existing.id }, data: { seatCapacity, active } });
    return existing.id;
  }

  const created = await tx.vehicle.create({
    data: { driverId, name, seatCapacity, active },
    select: { id: true },
  });
  return created.id;
};

/**
 * Hashes the demo password once per account.
 *
 * Exported so a caller can do the CPU-bound work *before* opening a
transaction and keep the transaction itself short; `seedDemoAccounts` falls
 * back to calling it directly.
 */
export const hashDemoPasswords = () =>
  Promise.all(
    seedUsers.map(() =>
      // Hashed per user so no two rows share a hash: reusing one hash across
      // accounts would make it obvious that they share a password.
      hashPassword(env.demoSeedPassword),
    ),
  );

/**
 * Applies the demo accounts with the given transaction client.
 * Returns a small summary for CLI output and tests.
 */
export const seedDemoAccounts = async (tx, { passwordHashes } = {}) => {
  assertSeedAllowed();
  assertSeedDataIsCoherent();

  const hashes = passwordHashes ?? (await hashDemoPasswords());

  const userIds = [];
  for (const [index, user] of seedUsers.entries()) {
    userIds.push(await upsertUser(tx, user, hashes[index]));
  }

  const vehicleIds = [];
  for (const vehicle of seedVehicles) {
    vehicleIds.push(await upsertVehicle(tx, vehicle));
  }

  return { users: userIds.length, vehicles: vehicleIds.length };
};
