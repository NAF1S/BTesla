import assert from 'node:assert/strict';

import { applyMigrations } from '../../src/db/migrations.js';
import { closePool, pool } from '../../src/db/pool.js';
import { seedTransportNetwork } from '../../src/db/seeds/transport-network.seed.js';

export { closePool, pool };

/**
 * Runs the transport seeder in its own transaction and returns its summary.
 * Used by tests to prove that repeated seeding is idempotent.
 */
export const runSeed = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const summary = await seedTransportNetwork(client);
    await client.query('COMMIT');
    return summary;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/** Applies server/db/*.sql (idempotent) and seeds, so tests run on a fresh database. */
export const prepareDatabase = async () => {
  await applyMigrations();
  return runSeed();
};

/** Runs `fn` inside a transaction that is always rolled back. */
export const withRollback = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
};

/** SELECT count(*) as a number. */
export const scalarCount = async (executor, sql, params = []) => {
  const { rows } = await executor.query(sql, params);
  return Number(rows[0].count);
};

/**
 * Asserts that `action()` fails with the given PostgreSQL SQLSTATE.
 *
 * The failing statement is wrapped in a savepoint that is always rolled back,
 * because a failed statement aborts the surrounding transaction in PostgreSQL.
 * This lets a single test assert several violations in one transaction; errors
 * thrown for the expected reason are swallowed, the transaction stays usable
 * and the failing write is undone.
 *
 * Returns the error so individual tests can make further assertions.
 */
export const expectPgError = async (client, action, sqlState) => {
  await client.query('SAVEPOINT expect_pg_error');
  try {
    await action();
  } catch (err) {
    assert.strictEqual(
      err.code,
      sqlState,
      `expected SQLSTATE ${sqlState} but got ${err.code} (${err.message})`,
    );
    await client.query('ROLLBACK TO SAVEPOINT expect_pg_error');
    return err;
  }
  await client.query('RELEASE SAVEPOINT expect_pg_error');
  assert.fail(`expected the query to fail with SQLSTATE ${sqlState}, but it succeeded`);
};
