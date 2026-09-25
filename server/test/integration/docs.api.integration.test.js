import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import { startApiServer } from '../helpers/api-server.js';
import { closePool } from '../helpers/db.js';

/**
 * `GET /api/docs` — the OpenAPI document, over HTTP.
 *
 * A small suite for a small endpoint, and it exists because the endpoint was
 * broken in a way nothing else caught. `res.sendFile` was handed a path built
 * from `new URL(…).pathname`, which on Windows carries a leading slash
 * (`/C:/Users/…`) that it cannot resolve, so the route answered **404 with an
 * `ENOENT`** rather than the document. The unit suite passed throughout, because
 * it reads the file itself rather than going through the route; only a request can
 * see this class of bug.
 *
 * The assertions are about what a consumer of the document depends on: the right
 * status, a content type it can act on, and bytes that really are the spec.
 */

let api;

/** Raw `fetch`, not the helper: the helper parses JSON and this response is YAML. */
const fetchDocs = async (path = '/docs') => {
  const response = await fetch(`${api.baseUrl}${path}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    text: await response.text(),
  };
};

before(async () => {
  api = await startApiServer();
});

after(async () => {
  await api?.close();
  await closePool();
});

describe('GET /docs', () => {
  it('serves the OpenAPI document as YAML, not as a 404', async () => {
    const response = await fetchDocs();

    assert.strictEqual(response.status, 200, 'the document must be reachable');
    assert.match(response.contentType, /text\/yaml/);
    assert.ok(
      response.text.startsWith('openapi: 3.1.0'),
      `the body should be the spec, but it started with ${JSON.stringify(response.text.slice(0, 40))}`,
    );
    assert.ok(response.text.length > 10_000, 'the whole document, not an error page');
  });

  it('sends the same document the repository holds', async () => {
    const response = await fetchDocs();

    // Byte-for-byte, so a route that rewrote or truncated the file would fail here
    // rather than quietly publishing a different contract.
    const onDisk = await (await import('node:fs/promises')).readFile(
      new URL('../../openapi.yaml', import.meta.url),
      'utf8',
    );

    assert.strictEqual(response.text.replace(/\r\n/g, '\n'), onDisk.replace(/\r\n/g, '\n'));
  });

  it('needs no session, so an editor or a generator can fetch it', async () => {
    // Documentation behind a login cannot be given to a client generator or
    // opened in an editor, which would defeat the point of publishing it.
    const response = await fetchDocs();

    assert.strictEqual(response.status, 200);
  });

  it('documents its own address, so a reader who finds it once can find it again', async () => {
    const { text } = await fetchDocs();

    assert.ok(text.includes('/docs:'), 'the spec should describe GET /docs');
  });

  it('leaves an unknown path under /docs as a 404, not a file read', async () => {
    // `sendFile` serves one path; a traversal attempt or a typo must not reach the
    // filesystem, and the error handler must not leak the path it tried.
    for (const path of ['/docs/nope', '/docs/../package.json', '/docs/openapi.yaml']) {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchDocs(path);
      assert.strictEqual(response.status, 404, path);
    }
  });

  it('names the cookie the API really issues', async () => {
    // The one place the document and the configuration have to agree, and the one
    // a reader will copy into a client.
    const { text } = await fetchDocs();

    assert.ok(text.includes(`name: ${env.authCookieName}`), `expected ${env.authCookieName}`);
  });
});
