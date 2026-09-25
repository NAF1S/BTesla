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

/**
 * The client.
 *
 * In tests the queries are emitted as events so a suite can *count* them, which
 * is the only honest way to assert that a page read is not an N+1: a test that
 * merely checked the response shape would pass just as happily against a loop of
 * one query per row. Emitting events is not free, so it is off everywhere else --
 * `env.nodeEnv` is already `test` under `node --test`, and the switch is here
 * rather than in the suite because the client is a module singleton.
 */
export const prisma = new PrismaClient({
  adapter,
  ...(env.nodeEnv === 'test' ? { log: [{ emit: 'event', level: 'query' }] } : {}),
});

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
