import { prisma, disconnect } from './prisma.js';
import { seedLocationNetwork } from './seeds/location.seed.js';

/**
 * Applies the PostGIS location seed: the Dhaka service zones, their pickup /
 * drop-off points, the routing vertices those points map onto, and the directed
 * edges that join them into one connected graph.
 *
 * Safe to run repeatedly: every record is upserted by its stable code inside a
 * single transaction, so re-running updates the existing rows instead of
 * duplicating them, and never deletes a user-created zone, point or edge. The
 * seed validates coordinate bounds, edge geometry and graph connectivity before
 * it commits; a failure rolls the whole thing back.
 *
 * Never runs automatically: it is only ever reached through `npm run db:seed`,
 * and it refuses to run when NODE_ENV=production unless ALLOW_DEMO_SEED=true.
 *
 * Usage: npm run db:seed   (run `npm run db:migrate` first)
 */

/** True when the error means the tables have not been created yet. */
const isMissingTable = (err) =>
  err.code === 'P2021' ||
  err.meta?.driverAdapterError?.cause?.originalCode === '42P01' ||
  /relation .* does not exist/i.test(err.message);

try {
  const summary = await prisma.$transaction((tx) => seedLocationNetwork(tx), {
    // The seed is a long chain of sequential writes followed by a graph
    // validation pass; give it more headroom than Prisma's 5s default so a slow
    // machine cannot abort it half way.
    timeout: 60_000,
  });

  console.log(
    `[db] location seed applied: ${summary.zones} zones, ${summary.points} service points, ` +
      `${summary.vertices} routing vertices, ${summary.edges} routing edges ` +
      `(${summary.bidirectionalEdges} bidirectional, ${summary.oneWayEdges} one-way)`,
  );
} catch (err) {
  console.error('[db] location seed failed:', err.message);
  if (isMissingTable(err)) console.error('[db] hint: run `npm run db:migrate` first');
  process.exitCode = 1;
} finally {
  await disconnect();
}
