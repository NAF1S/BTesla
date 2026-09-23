import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import { prisma } from '../../src/db/prisma.js';
import { verifyPassword } from '../../src/utils/password.js';
import { closePool, prepareDatabase, runAuthSeed } from '../helpers/db.js';

/**
 * Demo-account seeder tests.
 *
 * The seeder is what puts Nusrat, Rafiq, Shirin, Jashim and Bullet into a
 * development database, so these tests cover the three promises it makes:
 * it is idempotent, it never stores a plain-text password, and it never touches
 * an account outside the demo cast.
 */

const DEMO_PASSWORD = env.demoSeedPassword;

const DEMO_EMAILS = ['nusrat@example.com', 'rafiq@example.com', 'shirin@example.com', 'jashim@example.com'];

const PASSENGER_EMAILS = ['nusrat@example.com', 'rafiq@example.com', 'shirin@example.com'];

/** Everything the seed owns, counted by stable key rather than by id. */
const seedCounts = async () => ({
  users: await prisma.user.count({ where: { email: { in: DEMO_EMAILS } } }),
  passengerProfiles: await prisma.passengerProfile.count({
    where: { user: { email: { in: DEMO_EMAILS } } },
  }),
  driverProfiles: await prisma.driverProfile.count({
    where: { user: { email: { in: DEMO_EMAILS } } },
  }),
  vehicles: await prisma.vehicle.count({
    where: { driver: { user: { email: { in: DEMO_EMAILS } } } },
  }),
});

after(async () => {
  await closePool();
});

describe('demo account seed', () => {
  it('creates the demo cast with the profile its role requires', async () => {
    await prepareDatabase();

    assert.deepStrictEqual(await seedCounts(), {
      users: 4,
      passengerProfiles: 3,
      driverProfiles: 1,
      vehicles: 1,
    });

    for (const email of PASSENGER_EMAILS) {
      const user = await prisma.user.findUnique({
        where: { email },
        select: { role: true, passengerProfile: { select: { id: true } } },
      });

      assert.strictEqual(user.role, 'PASSENGER', `${email} should be a passenger`);
      assert.ok(user.passengerProfile, `${email} should have a passenger profile`);
    }
  });

  it('gives Jashim a driver profile and his vehicle Bullet with three seats', async () => {
    await prepareDatabase();

    const jashim = await prisma.user.findUnique({
      where: { email: 'jashim@example.com' },
      select: {
        role: true,
        passengerProfile: { select: { id: true } },
        driverProfile: {
          select: {
            id: true,
            vehicles: { select: { name: true, seatCapacity: true, active: true } },
          },
        },
      },
    });

    assert.strictEqual(jashim.role, 'DRIVER');
    assert.strictEqual(jashim.passengerProfile, null, 'a driver must not get a passenger profile');
    assert.ok(jashim.driverProfile, 'a driver must get a driver profile');

    assert.deepStrictEqual(jashim.driverProfile.vehicles, [
      { name: 'Bullet', seatCapacity: 3, active: true },
    ]);
  });

  it('is idempotent: re-seeding creates no duplicate users, profiles or vehicles', async () => {
    await prepareDatabase();
    const before = await seedCounts();

    await runAuthSeed();
    await runAuthSeed();

    assert.deepStrictEqual(await seedCounts(), before);
  });

  it('stores a bcrypt hash with a distinct salt per account', async () => {
    await prepareDatabase();

    const users = await prisma.user.findMany({
      where: { email: { in: DEMO_EMAILS } },
      select: { email: true, passwordHash: true },
    });

    assert.strictEqual(users.length, DEMO_EMAILS.length);

    const hashes = new Set();
    for (const user of users) {
      assert.ok(user.passwordHash, `${user.email} should have a password hash`);
      assert.notStrictEqual(user.passwordHash, DEMO_PASSWORD, 'the plain password must never be stored');
      assert.match(user.passwordHash, /^\$2[aby]\$\d{2}\$/, 'expected a bcrypt hash');
      hashes.add(user.passwordHash);
    }

    // Distinct hashes mean it is not obvious from the table that the accounts
    // share a password.
    assert.strictEqual(hashes.size, users.length, 'each account needs its own salt');
  });

  it('stores a hash the configured demo password verifies against', async () => {
    await prepareDatabase();

    const nusrat = await prisma.user.findUnique({
      where: { email: 'nusrat@example.com' },
      select: { passwordHash: true },
    });

    assert.strictEqual(await verifyPassword(DEMO_PASSWORD, nusrat.passwordHash), true);
    assert.strictEqual(await verifyPassword('not-the-demo-password', nusrat.passwordHash), false);
  });

  it('leaves accounts outside the demo cast untouched', async () => {
    // ada@example.com comes from 02-seed.sql and belongs to no demo actor, so
    // the seeder must neither delete it nor give it a demo password.
    const ada = await prisma.user.findUnique({
      where: { email: 'ada@example.com' },
      select: { name: true, passwordHash: true },
    });

    assert.ok(ada, 'the pre-existing sample user should still exist');

    await runAuthSeed();

    const after = await prisma.user.findUnique({
      where: { email: 'ada@example.com' },
      select: { name: true, passwordHash: true },
    });

    assert.strictEqual(after.name, ada.name);
    assert.strictEqual(after.passwordHash, null, 'a non-demo account must not receive a demo password');
  });

  it('prevents duplicate login identifiers', async () => {
    await assert.rejects(
      prisma.user.create({ data: { name: 'Impostor', email: 'nusrat@example.com', role: 'PASSENGER' } }),
      (err) => err.code === 'P2002',
      'the same email must not be insertable twice',
    );
  });

  it('prevents identifiers that differ only by case', async () => {
    try {
      await assert.rejects(
        prisma.user.create({ data: { name: 'Case Variant', email: 'NUSRAT@example.com', role: 'PASSENGER' } }),
        (err) =>
          err.code === 'P2002' || err.meta?.driverAdapterError?.cause?.originalCode === '23505',
        'a case-variant duplicate email must be rejected by the unique index on lower(email)',
      );
    } finally {
      // Defensive: if the constraint ever regressed, leave nothing behind.
      await prisma.user.deleteMany({ where: { email: 'NUSRAT@example.com' } });
    }
  });

  it('prevents a second passenger profile for the same user', async () => {
    const nusrat = await prisma.user.findUnique({
      where: { email: 'nusrat@example.com' },
      select: { id: true },
    });

    await assert.rejects(
      prisma.passengerProfile.create({ data: { userId: nusrat.id } }),
      (err) => err.code === 'P2002',
      'a user may have at most one passenger profile',
    );
  });

  it('prevents a second driver profile for the same user', async () => {
    const jashim = await prisma.user.findUnique({
      where: { email: 'jashim@example.com' },
      select: { id: true },
    });

    await assert.rejects(
      prisma.driverProfile.create({ data: { userId: jashim.id } }),
      (err) => err.code === 'P2002',
      'a user may have at most one driver profile',
    );
  });

  it('refuses a vehicle with no seat capacity', async () => {
    const jashim = await prisma.user.findUnique({
      where: { email: 'jashim@example.com' },
      select: { driverProfile: { select: { id: true } } },
    });

    await assert.rejects(
      prisma.vehicle.create({
        data: { driverId: jashim.driverProfile.id, name: 'Zero Seater', seatCapacity: 0 },
      }),
      'the check constraint must reject a non-positive seat capacity',
    );
  });
});
