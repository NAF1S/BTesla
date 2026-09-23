import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { env } from '../config/env.js';

/**
 * The single Prisma client for the process.
 *
 * Prisma 7 talks to PostgreSQL through a driver adapter, so the connection
 * string is passed explicitly to the adapter. Resolving it via src/config/env.js
 * (rather than letting Prisma read DATABASE_URL itself) keeps the API working
 * with no .env file, using the same docker-compose defaults.
 */
const adapter = new PrismaPg({ connectionString: env.databaseUrl });

export const prisma = new PrismaClient({ adapter });

/** Runs `SELECT 1` and reports whether the database is reachable. */
export const checkDatabase = async () => {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'up', latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { status: 'down', error: err.message };
  }
};

export const disconnect = () => prisma.$disconnect();
