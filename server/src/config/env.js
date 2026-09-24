import 'dotenv/config';

import {
  DEFAULT_RUSH_HOUR_WINDOWS,
  parseRushHourWindows,
} from '../utils/time.js';

const toNumber = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};
// Mirrors the defaults in docker-compose.yml so the API works with no .env file.
const defaultDatabaseUrl = () => {
  const user = process.env.POSTGRES_USER ?? 'postgres';
  const password = process.env.POSTGRES_PASSWORD ?? 'postgres';
  const host = process.env.POSTGRES_HOST ?? 'localhost';
  const port = process.env.POSTGRES_PORT ?? '55432';
  const database = process.env.POSTGRES_DB ?? 'TeslaB';
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
};

const toBoolean = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
};

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';

/**
 * A development-only fallback so the API still runs with no .env file, matching
 * the database URL convention above. Production must supply a real secret;
 * `assertProductionSecrets()` enforces that when the server boots.
 */
const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret-do-not-use-in-production';

export const env = {
  nodeEnv,
  isProduction,
  port: toNumber(process.env.PORT, 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:3000',
  // The single source of the connection string: the Prisma CLI resolves it
  // through this module too (see prisma7.config.ts), so the API and the CLI
  // can never drift apart.
  databaseUrl: process.env.DATABASE_URL ?? defaultDatabaseUrl(),

  // --- Authentication ---------------------------------------------------
  jwtSecret: process.env.JWT_SECRET ?? (isProduction ? '' : DEV_JWT_SECRET),
  /** Token lifetime, in seconds. Drives both the JWT `exp` and the cookie Max-Age. */
  authTokenTtlSeconds: toNumber(process.env.AUTH_TOKEN_TTL_SECONDS, 60 * 60 * 2),
  authCookieName: process.env.AUTH_COOKIE_NAME ?? 'teslab_auth',
  /** Secure cookies are the default in production; override for TLS terminators. */
  cookieSecure: toBoolean(process.env.COOKIE_SECURE, isProduction),
  /** 'lax' suits the same-origin proxy setup; use 'none' only for cross-site use. */
  cookieSameSite: process.env.COOKIE_SAME_SITE ?? 'lax',
  bcryptCost: toNumber(process.env.BCRYPT_COST, 10),

  // --- Demo seed (development only) -------------------------------------
  demoSeedPassword: process.env.DEMO_SEED_PASSWORD ?? 'DemoPass123!',
  allowDemoSeed: toBoolean(process.env.ALLOW_DEMO_SEED, false),

  // --- Routing ----------------------------------------------------------
  routing: {
    /**
     * Asia/Dhaka rush-hour windows, e.g. "07:30-10:30,16:30-20:00". Half-open:
     * the start minute is rush hour, the end minute is not. Invalid values throw
     * here, at process start, so a typo cannot silently mis-price every route.
     */
    rushHourWindows: parseRushHourWindows(
      process.env.RUSH_HOUR_WINDOWS || DEFAULT_RUSH_HOUR_WINDOWS,
    ),
    /** PostgreSQL statement_timeout applied to the routing queries. */
    statementTimeoutMs: toNumber(process.env.ROUTING_STATEMENT_TIMEOUT_MS, 5_000),
    /** Prisma's own ceiling for the routing transaction, above the statement timeout. */
    queryTimeoutMs: toNumber(process.env.ROUTING_QUERY_TIMEOUT_MS, 10_000),
  },
};

/**
 * Fails fast when a production deployment is missing required secrets.
 *
 * Called from the server bootstrap rather than at module load, so that tooling
 * which merely imports this module (the Prisma CLI, for example) keeps working
 * in a production build image where the secret is supplied only at runtime.
 */
export const assertProductionSecrets = () => {
  if (isProduction && env.jwtSecret === '') {
    throw new Error('JWT_SECRET must be set when NODE_ENV=production');
  }
};
