import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './pool.js';

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');

/**
 * Applies every .sql file in server/db in filename order.
 * Each file runs in its own transaction; the SQL is written to be idempotent.
 *
 * Exported separately from migrate.js so tests (and future tooling) can apply
 * the schema without spawning the CLI runner.
 */
export const applyMigrations = async () => {
  const files = (await readdir(dbDir)).filter((file) => file.endsWith('.sql')).sort();

  if (files.length === 0) {
    console.log('[db] no .sql files found in', dbDir);
    return [];
  }

  for (const file of files) {
    const sql = await readFile(path.join(dbDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`[db] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to apply ${file}: ${err.message}`, { cause: err });
    } finally {
      client.release();
    }
  }

  console.log('[db] migration complete');
  return files;
};
