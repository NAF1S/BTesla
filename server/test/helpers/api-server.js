import './test-env.js';

import { createServer } from 'node:http';

import app from '../../src/app.js';

/**
 * Starts the real Express app on an ephemeral port so integration tests can
 * exercise the full HTTP stack (routing, validation, serializers, error
 * handler) using the built-in fetch.
 */
export const startApiServer = async () => {
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api`;

  return {
    baseUrl,
    /** GET a path under /api; returns { status, body }. */
    request: async (path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, options);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
