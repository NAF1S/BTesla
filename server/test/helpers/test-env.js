// Imported first, before anything from src/, because src/config/env.js reads
// process.env at module-evaluation time. NODE_ENV=test switches request
// logging off in src/app.js.
// `node --test` runs every test file in its own process, so this is safe.
process.env.NODE_ENV ??= 'test';
