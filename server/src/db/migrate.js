import { applyMigrations } from './migrations.js';
import { disconnect } from './prisma.js';

/** CLI runner for `npm run db:migrate`. The logic lives in ./migrations.js. */
try {
  await applyMigrations();
} catch (err) {
  console.error('[db]', err.message);
  process.exitCode = 1;
} finally {
  await disconnect();
}
