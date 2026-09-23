import 'dotenv/config';

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

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: toNumber(process.env.PORT, 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:3000',
  databaseUrl: process.env.DATABASE_URL ?? defaultDatabaseUrl(),
  dbPoolMax: toNumber(process.env.DB_POOL_MAX, 10),
};
