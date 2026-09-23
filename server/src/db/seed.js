import { prisma, disconnect } from './prisma.js';
import { seedTransportNetwork } from './seeds/transport-network.seed.js';

/**
 * Applies the transport-network seed data (zones, stops, corridors, corridor
 * stop order and directional travel estimates).
 *
 * Safe to run repeatedly: every record is upserted by its stable code inside a
 * single transaction, so re-running updates the existing seed rows instead of
 * duplicating them and never deletes user-created data.
 *
 * Usage: npm run db:seed   (run `npm run db:migrate` first)
 */

/** True when the error means the tables have not been created yet. */
const isMissingTable = (err) =>
  err.code === 'P2021' ||
  err.meta?.driverAdapterError?.cause?.originalCode === '42P01' ||
  /relation .* does not exist/i.test(err.message);

try {
  const summary = await prisma.$transaction((tx) => seedTransportNetwork(tx), {
    // The seed is a long chain of sequential dependent upserts; give it more
    // headroom than Prisma's 5s default so a slow machine cannot abort it.
    timeout: 30_000,
  });

  console.log(
    `[db] transport seed applied: ${summary.zones} zones, ${summary.stops} stops, ` +
      `${summary.corridors} corridors, ${summary.corridorStops} corridor stops, ` +
      `${summary.travelEstimates} travel estimates`,
  );
} catch (err) {
  console.error('[db] transport seed failed:', err.message);
  if (isMissingTable(err)) console.error('[db] hint: run `npm run db:migrate` first');
  process.exitCode = 1;
} finally {
  await disconnect();
}
