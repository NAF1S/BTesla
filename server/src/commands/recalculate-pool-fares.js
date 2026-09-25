import { env } from '../config/env.js';
import { disconnect, prisma } from '../db/prisma.js';
import { POOL_FARE_STATUS, SHARED_FARE_RULE_VERSION } from '../services/pool-fare.rules.js';
import { recalculatePoolFaresStandalone } from '../services/pool-fare.service.js';

/**
 * Recalculates the shared fares of every forming pool whose calculation is
 * missing or out of date.
 *
 *     npm run pool-fares:recalculate --workspace server
 *
 * Recalculation is a *triggered* operation -- it runs inside the transaction that
 * changes a pool's plan, so a matched passenger can never exist without a fare --
 * which means this command should find nothing to do. It exists for the two cases
 * where that is not enough: a plan change that predates the shared-fare milestone,
 * and a bug in a past calculation that a deployment has since fixed. Both are
 * repairs, and the command says which pools it repaired.
 *
 * Idempotent, and safe to run repeatedly: a pool already calculated for its
 * current version under the current rule version is left alone. A pool whose plan
 * moves on while the command is running is skipped with a conflict rather than
 * priced against a version that no longer exists -- the pool's row lock is what
 * decides that, and the next run picks it up.
 */

const pools = await prisma.ridePool.findMany({
  where: { status: 'FORMING' },
  select: {
    id: true,
    version: true,
    fareCalculations: {
      select: { poolVersion: true, sharedFareRuleVersion: true, status: true },
    },
  },
  orderBy: { createdAt: 'asc' },
  take: env.fare.pool.maxPoolsPerSweep,
});

const upToDate = (pool) =>
  pool.fareCalculations.some(
    (calculation) =>
      calculation.poolVersion === pool.version &&
      calculation.sharedFareRuleVersion === SHARED_FARE_RULE_VERSION &&
      calculation.status === POOL_FARE_STATUS.CURRENT,
  );

const stale = pools.filter((pool) => !upToDate(pool));

// A pool that is already current never enters the loop, so it has to be counted
// here: "0 recalculated, 0 already current" would read as if the sweep had found
// nothing at all.
const summary = {
  examined: pools.length,
  recalculated: 0,
  unchanged: pools.length - stale.length,
  skipped: 0,
};

try {
  for (const pool of stale) {
    try {
      const outcome = await recalculatePoolFaresStandalone({
        ridePoolId: pool.id,
        expectedPoolVersion: pool.version,
      });

      if (outcome.status === 'created') {
        summary.recalculated += 1;
        console.log(
          `[pool-fares] recalculated pool ${pool.id} v${pool.version}: ` +
            `${outcome.legs} leg(s), ${outcome.passengers} passenger(s), ` +
            `total ${outcome.totals.totalFinalPassengerFare.toFixed(2)}`,
        );
      } else {
        summary.unchanged += 1;
      }
    } catch (err) {
      // One pool that cannot be priced must not stop the sweep: a repair run is
      // usually about the pools that *can* be.
      summary.skipped += 1;
      console.error(`[pool-fares] skipped pool ${pool.id}:`, err.message);
    }
  }

  console.log(
    `[pool-fares] repair sweep: ${summary.recalculated} recalculated, ` +
      `${summary.unchanged} already current, ${summary.skipped} skipped, ` +
      `${summary.examined} forming pool(s) examined`,
  );
} catch (err) {
  console.error('[pool-fares] repair sweep failed:', err.message);
  process.exitCode = 1;
} finally {
  await disconnect();
}
