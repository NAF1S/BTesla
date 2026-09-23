import { prisma, disconnect } from './prisma.js';
import { hashDemoPasswords, seedDemoAccounts } from './seeds/auth.seed.js';
import { seedLocationNetwork } from './seeds/location.seed.js';

/**
 * Applies all development seed data:
 *
 *   1. the PostGIS location foundation -- the Dhaka service zones, their pickup
 *      and drop-off points, the routing vertices those points map onto, and the
 *      directed edges that join them into one connected graph (validated for
 *      coordinate bounds, edge geometry and connectivity before it commits);
 *   2. the demo cast -- Nusrat, Rafiq, Shirin, Jashim and Jashim's vehicle
 *      Bullet -- with passwords hashed from DEMO_SEED_PASSWORD.
 *
 * Safe to run repeatedly: every record is upserted by a stable key inside a
 * single transaction, so re-running updates existing rows instead of
 * duplicating them and never deletes or overwrites data it does not own.
 *
 * Never runs automatically: it is only ever reached through `npm run db:seed`,
 * and the demo accounts refuse to seed when NODE_ENV=production unless
 * ALLOW_DEMO_SEED=true.
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

  const { location, accounts } = await prisma.$transaction(
    async (tx) => ({
      location: await seedLocationNetwork(tx),
      accounts: await seedDemoAccounts(tx, { passwordHashes }),
    }),
    {
      // Both seeds are long chains of sequential writes, and the location seed
      // ends with a graph validation pass; give them more headroom than
      // Prisma's 5s default so a slow machine cannot abort half way.
      timeout: 60_000,
    },
  );

  console.log(
    `[db] location seed applied: ${location.zones} zones, ${location.points} service points, ` +
      `${location.vertices} routing vertices, ${location.edges} routing edges ` +
      `(${location.bidirectionalEdges} bidirectional, ${location.oneWayEdges} one-way)`,
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
