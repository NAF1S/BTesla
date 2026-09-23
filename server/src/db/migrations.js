import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from './prisma.js';

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');

/**
 * Applies every .sql file in server/db in filename order.
 * Each file runs in its own transaction; the SQL is written to be idempotent.
 *
 * The files are executed through Prisma's raw-SQL escape hatch rather than a
 * second database driver, so Prisma stays the only way this codebase reaches
 * PostgreSQL. Prisma is not the owner of the schema here -- only the executor.
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
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(sql);
      });
      console.log(`[db] applied ${file}`);
    } catch (err) {
      throw new Error(`Failed to apply ${file}: ${err.message}`, { cause: err });
    }
  }

  console.log('[db] migration complete');
  return files;
};
