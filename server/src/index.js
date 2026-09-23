import { createServer } from 'node:http';

import app from './app.js';
import { env } from './config/env.js';
import { checkDatabase, disconnect } from './db/prisma.js';

const server = createServer(app);

server.listen(env.port, async () => {
  console.log(`[api] listening on http://localhost:${env.port} (${env.nodeEnv})`);

  const database = await checkDatabase();
  console.log(
    database.status === 'up'
      ? `[db] connected (${database.latencyMs}ms)`
      : `[db] NOT reachable — ${database.error}`,
  );
});

const shutdown = (signal) => {
  console.log(`[api] ${signal} received, shutting down...`);
  server.close(async () => {
    await disconnect();
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
