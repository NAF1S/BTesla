import assert from 'node:assert/strict';

import { applyMigrations } from '../../src/db/migrations.js';
import { disconnect, prisma } from '../../src/db/prisma.js';
import { seedLocationNetwork } from '../../src/db/seeds/location.seed.js';

/**
 * Raw-SQL executor that reproduces the `{ rows }` shape the pg driver used to
 * provide, so the tests that assert database-level behaviour keep working
 * unchanged while Prisma remains the only database client in the project.
 *
 * It deliberately keeps the historical `pool` / `closePool` names those tests
 * were written against: the object still answers `.query(sql, params)` with
 * `{ rows }`, it is simply backed by Prisma now.
 *
 * Placeholders stay PostgreSQL-style ($1, $2, ...).
 */
const executor = (tx) => ({
  query: async (sql, params = []) => {
    const rows = await tx.$queryRawUnsafe(sql, ...params);
    // `rowCount` mirrors pg for reads, which is how the tests use it. It is not
    // an affected-row count for writes, and no test relies on that.
    return { rows, rowCount: Array.isArray(rows) ? rows.length : 0 };
  },
});

/**
 * A Prisma client that also answers `.query()`, so a single object can be used
 * both to drive Prisma models (for example to run the seeder) and to drop to
 * raw SQL for assertions in the same test.
 */
const withRawQuery = (tx) =>
  new Proxy(tx, {
    get(target, prop) {
      if (prop === 'query') return executor(target).query;
      const value = target[prop];
      // Bind so Prisma's own methods keep the correct receiver.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

/** A standalone raw-SQL executor, for setup/teardown and direct assertions. */
export const pool = withRawQuery(prisma);

/** Releases the Prisma client. */
export const closePool = disconnect;

/**
 * The location seed is a long chain of sequential writes followed by a graph
 * validation pass, so it needs more headroom than Prisma's 5s default
 * transaction timeout.
 */
const TRANSACTION_OPTIONS = { timeout: 60_000 };

/** Runs the location seeder in its own transaction and returns its summary. */
export const runSeed = () =>
  prisma.$transaction((tx) => seedLocationNetwork(tx), TRANSACTION_OPTIONS);

/**
 * Applies server/db/*.sql (idempotent) and the location seed, so tests run
 * against a database that already holds the seeded zones, points and graph.
 */
export const prepareDatabase = async () => {
  await applyMigrations();
  return runSeed();
};

/** Sentinel used to force a rollback without surfacing as a test failure. */
const ROLLBACK = Symbol('rollback');

/**
 * Runs `fn` inside a transaction that is always rolled back. `fn` receives a
 * Prisma transaction client that also answers `.query()`.
 */
export const withRollback = async (fn) => {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(withRawQuery(tx));
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
};

/** SELECT count(*) as a number. */
export const scalarCount = async (exec, sqlText, params = []) => {
  const { rows } = await exec.query(sqlText, params);
  return Number(rows[0].count);
};

/**
 * Extracts the PostgreSQL SQLSTATE from whatever Prisma threw.
 *
 * Raw SQL that fails is reported as P2010 with the original SQLSTATE nested in
 * the driver adapter error; errors that already carry a `code` are passed
 * through unchanged.
 */
export const sqlStateOf = (err) =>
  err?.meta?.driverAdapterError?.cause?.originalCode ?? err?.code ?? null;

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
export const expectPgError = async (exec, action, sqlState) => {
  await exec.query('SAVEPOINT expect_pg_error');
  try {
    await action();
  } catch (err) {
    assert.strictEqual(
      sqlStateOf(err),
      sqlState,
      `expected SQLSTATE ${sqlState} but got ${sqlStateOf(err)} (${err.message})`,
    );
    await exec.query('ROLLBACK TO SAVEPOINT expect_pg_error');
    return err;
  }
  await exec.query('RELEASE SAVEPOINT expect_pg_error');
  assert.fail(`expected the query to fail with SQLSTATE ${sqlState}, but it succeeded`);
};
