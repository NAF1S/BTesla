import { disconnect } from '../db/prisma.js';
import { expireOverdueRideRequests } from '../services/ride-request.service.js';

/**
 * Expires overdue ride requests.
 *
 * There is no scheduler in this project, so expiration is an *operation* with a
 * command in front of it rather than a timer inside the API process. Run it from
 * cron, a Kubernetes CronJob, or whatever the deployment already uses:
 *
 *     npm run ride-requests:expire --workspace server
 *
 * Safe to run as often as you like, and safe to run concurrently: each request
 * is expired inside its own transaction, under a row lock, and a request that a
 * passenger cancelled first is simply skipped.
 *
 * Usage: npm run ride-requests:expire   (from the repo root)
 */
try {
  const summary = await expireOverdueRideRequests();

  console.log(
    `[rides] expiration sweep: ${summary.expired} expired, ${summary.skipped} skipped ` +
      `(already terminal or no longer overdue), ${summary.examined} examined`,
  );
} catch (err) {
  console.error('[rides] expiration sweep failed:', err.message);
  process.exitCode = 1;
} finally {
  await disconnect();
}
