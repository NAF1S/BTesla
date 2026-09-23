import { Router } from 'express';

import { checkDatabase } from '../db/pool.js';

const router = Router();

router.get('/', async (_req, res) => {
  const database = await checkDatabase();

  res.json({
    // "degraded" means the API is up but Postgres is not reachable.
    status: database.status === 'up' ? 'ok' : 'degraded',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database,
  });
});

export default router;
