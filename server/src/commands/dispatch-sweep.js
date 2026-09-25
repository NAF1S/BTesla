import { disconnect } from '../db/prisma.js';
import { expireOverdueOffers, retryWaitingRequests } from '../services/dispatch.service.js';

/**
 * Ends overdue dispatch offers and re-offers the requests that lost one.
 *
 * There is no scheduler in this project, so dispatch is driven by *operations*
 * with commands in front of them rather than timers inside the API process. This
 * is the one a cron entry, a Kubernetes CronJob or a queue worker would call:
 *
 *     npm run dispatch:sweep --workspace server
 *
 * Two sweeps, in the order that matters:
 *
 *   1. offers whose deadline has passed are expired, and each request that lost
 *      one is offered to its next-best driver;
 *   2. requests that are waiting with nobody looking at them -- because a
 *      process died, a dispatch call failed, or an offer ended without the
 *      follow-up running -- get an offer.
 *
 * Safe to run as often as you like, and safe to run concurrently: every step is
 * idempotent, every write is guarded by a partial unique index, and an offer that
 * a driver already answered is skipped rather than failed.
 *
 * Usage: npm run dispatch:sweep   (from the repo root)
 */
try {
  const now = new Date();

  const expired = await expireOverdueOffers({ now });
  console.log(
    `[dispatch] offers: ${expired.expired} expired, ${expired.skipped} skipped ` +
      `(already answered), ${expired.examined} overdue, ${expired.redispatched} re-offered`,
  );

  const waiting = await retryWaitingRequests({ now });
  console.log(
    `[dispatch] waiting requests: ${waiting.dispatched} offered, ${waiting.skipped} without an ` +
      `eligible driver, ${waiting.examined} examined`,
  );
} catch (err) {
  console.error('[dispatch] sweep failed:', err.message);
  process.exitCode = 1;
} finally {
  await disconnect();
}
