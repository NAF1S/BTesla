import pg from 'pg';

import { env } from '../config/env.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: env.dbPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// A background/idle client error must not take the process down.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export const query = (text, params) => pool.query(text, params);

/** Runs `SELECT 1` and reports whether the database is reachable. */
export const checkDatabase = async () => {
  const startedAt = Date.now();
  try {
    await query('SELECT 1');
    return { status: 'up', latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { status: 'down', error: err.message };
  }
};

export const closePool = () => pool.end();
