import { closePool, pool } from './pool.js';
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
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const summary = await seedTransportNetwork(client);
  await client.query('COMMIT');
  console.log(
    `[db] transport seed applied: ${summary.zones} zones, ${summary.stops} stops, ` +
      `${summary.corridors} corridors, ${summary.corridorStops} corridor stops, ` +
      `${summary.travelEstimates} travel estimates`,
  );
} catch (err) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The connection is already gone; the original error is the useful one.
  }
  console.error('[db] transport seed failed:', err.message);
  if (err.code === '42P01') console.error('[db] hint: run `npm run db:migrate` first');
  process.exitCode = 1;
} finally {
  client.release();
  await closePool();
}
