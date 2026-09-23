import { prisma, disconnect } from './prisma.js';
import { hashDemoPasswords, seedDemoAccounts } from './seeds/auth.seed.js';
import { seedTransportNetwork } from './seeds/transport-network.seed.js';

/**
 * Applies all development seed data:
 *
 *   1. the transport network (zones, stops, corridors and directional travel
 *      estimates);
 *   2. the demo cast -- Nusrat, Rafiq, Shirin, Jashim and Jashim's vehicle
 *      Bullet -- with passwords hashed from DEMO_SEED_PASSWORD.
 *
 * Safe to run repeatedly: every record is upserted by a stable key inside a
 * single transaction, so re-running updates existing rows instead of
 * duplicating them and never overwrites non-seed data.
 *
 * Usage: npm run db:seed   (run `npm run db:migrate` first)
 */

/** True when the error means the tables have not been created yet. */
const isMissingTable = (err) =>
  err.code === 'P2021' ||
  err.meta?.driverAdapterError?.cause?.originalCode === '42P01' ||
  /relation .* does not exist/i.test(err.message);

try {
  // Hashing is CPU-bound, so it happens before the transaction opens and the
  // transaction itself stays short.
  const passwordHashes = await hashDemoPasswords();

  const { transport, accounts } = await prisma.$transaction(
    async (tx) => ({
      transport: await seedTransportNetwork(tx),
      accounts: await seedDemoAccounts(tx, { passwordHashes }),
    }),
    {
      // Both seeds are long chains of sequential dependent writes; give them
      // more headroom than Prisma's 5s default so a slow machine cannot abort.
      timeout: 60_000,
    },
  );

  console.log(
    `[db] transport seed applied: ${transport.zones} zones, ${transport.stops} stops, ` +
      `${transport.corridors} corridors, ${transport.corridorStops} corridor stops, ` +
      `${transport.travelEstimates} travel estimates`,
  );
  console.log(
    `[db] demo accounts applied: ${accounts.users} users, ${accounts.vehicles} vehicles ` +
      `(development/demo only; password from DEMO_SEED_PASSWORD)`,
  );
} catch (err) {
  console.error('[db] seed failed:', err.message);
  if (isMissingTable(err)) console.error('[db] hint: run `npm run db:migrate` first');
  process.exitCode = 1;
} finally {
  await disconnect();
}
