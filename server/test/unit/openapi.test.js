import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { env } from '../../src/config/env.js';

/**
 * The OpenAPI document, checked against the code.
 *
 * There is no YAML parser in this project's dependencies, and writing one to
 * validate the spec would be a worse idea than the spec. So this suite checks the
 * document the way drift actually happens: **by path**. A route that exists and is
 * not documented, or a documented path that no longer exists, is the failure mode
 * that matters -- a spec nobody updates is worse than no spec, because it is
 * believed.
 *
 * The routes are read from the source rather than from a running Express router.
 * Express does not expose its mount prefixes, so reconstructing them from
 * layer-regexp internals is a trick that breaks on a version bump; reading
 * `router.use('/auth', authRoutes)` and `router.get('/me/rides', …)` is the same
 * information stated plainly, and it fails loudly when the shape of a route file
 * changes rather than quietly returning nothing.
 *
 * The rest of the assertions are about what a reader is promised: that the
 * security scheme matches the cookie the API really sets, that the demo cast is
 * used in the examples, and that no placeholder name leaked in.
 */

const SERVER_ROOT = new URL('../../', import.meta.url);

const readText = async (relativePath) =>
  (await readFile(new URL(relativePath, SERVER_ROOT), 'utf8')).replace(/\r\n/g, '\n');

// Normalised eagerly: the file is checked out with whatever line endings the
// platform prefers, and every slice below searches for a `\n`.
const spec = await readText('openapi.yaml');

/**
 * The paths the document declares, read out of the `paths:` block.
 *
 * The block's keys are the only lines in it indented exactly two spaces and
 * ending with a colon, which is precise enough for a hand-written spec and does
 * not need a parser to be true.
 */
const documentedPaths = () => {
  const start = spec.indexOf('\npaths:\n');
  const end = spec.indexOf('\ncomponents:\n');

  assert.ok(start !== -1 && end !== -1, 'the spec has both a paths: and a components: block');

  return spec
    .slice(start, end)
    .split('\n')
    .filter((line) => /^ {2}\/\S*:\s*$/.test(line))
    .map((line) => line.trim().replace(/:$/, ''));
};

/** `router.use('/auth', authRoutes)` -> { authRoutes: '/auth' } */
const mountPrefixes = async () => {
  const index = await readText('src/routes/index.js');
  const prefixes = {};

  for (const match of index.matchAll(/router\.use\('([^']*)',\s*(\w+)\)/g)) {
    prefixes[match[2]] = match[1];
  }

  return prefixes;
};

/** Every method and path the route files declare, as `METHOD /full/path`. */
const mountedRoutes = async () => {
  const prefixes = await mountPrefixes();
  const directory = new URL('src/routes/', SERVER_ROOT);
  const files = (await readdir(directory)).filter((name) => name.endsWith('.routes.js'));
  const routes = [];

  for (const file of files) {
    const source = (await readFile(new URL(file, directory), 'utf8')).replace(/\r\n/g, '\n');

    // The import name of the router is the file's base name in camel case plus
    // `Routes` (`ride-request.routes.js` is mounted as `rideRequestRoutes`), which
    // is how the mount prefix is looked up. A file mounted nowhere contributes no
    // paths, which the assertion below catches.
    const base = file.replace('.routes.js', '');
    const camel = base
      .split('-')
      .map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1)))
      .join('');
    const prefix = prefixes[`${camel}Routes`] ?? '';

    for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
      const path = `${prefix}${match[2]}`.replace(/\/$/, '') || '/';
      routes.push({ method: match[1].toUpperCase(), path });
    }
  }

  return routes;
};

/** Express `:param` to the document's `{param}`. */
const normalize = (path) => path.replace(/:[A-Za-z0-9_]+/g, (match) => `{${match.slice(1)}}`);

describe('the OpenAPI document', () => {
  it('is an OpenAPI 3.1 document with the metadata a reader needs', () => {
    assert.match(spec, /^openapi: 3\.1\.0$/m);
    assert.match(spec, /^info:/m);
    assert.match(spec, /^ {2}title: TeslaB API$/m);
    assert.match(spec, /^ {2}version: \d+\.\d+\.\d+$/m);
    assert.match(spec, /^servers:/m);
    assert.match(spec, /^components:/m);
  });

  it('describes the server the API actually listens on', () => {
    assert.ok(
      spec.includes(`localhost:${env.port}`),
      `the document should name port ${env.port}, which is what the API binds`,
    );
  });

  it('names the cookie the API really sets', () => {
    // The security scheme is only useful if it points at the right cookie, and
    // the cookie name is configuration.
    assert.match(spec, /^ {4}cookieAuth:$/m);
    assert.ok(spec.includes(`name: ${env.authCookieName}`));
  });

  it('documents every endpoint this milestone added', () => {
    for (const path of [
      '/passengers/me/current-ride',
      '/passengers/me/rides',
      '/passengers/me/rides/{rideRequestId}',
      '/drivers/me/availability',
      '/drivers/me/current-pool',
      '/drivers/me/rides',
      '/drivers/me/rides/{poolId}',
      '/docs',
    ]) {
      assert.ok(documentedPaths().includes(path), `${path} is missing from the document`);
    }
  });

  it('documents the methods those endpoints answer', () => {
    const availability = spec.slice(
      spec.indexOf('\n  /drivers/me/availability:\n'),
      spec.indexOf('\n  /drivers/me/current-pool:\n'),
    );

    assert.match(availability, /^ {4}get:$/m, 'GET /drivers/me/availability');
    assert.match(availability, /^ {4}patch:$/m, 'PATCH /drivers/me/availability');
  });

  it('describes every path the router mounts, so the document cannot fall behind', async () => {
    const documented = new Set(documentedPaths());
    const mounted = (await mountedRoutes()).map((route) => normalize(route.path));
    const unique = [...new Set(mounted)];

    assert.ok(unique.length > 20, `expected the whole API surface, found ${unique.length}`);

    const undocumented = unique.filter((path) => !documented.has(path));
    assert.deepStrictEqual(
      undocumented,
      [],
      `these mounted paths are missing from openapi.yaml: ${undocumented.join(', ')}`,
    );
  });

  it('documents no path the router has stopped mounting', async () => {
    const mounted = new Set((await mountedRoutes()).map((route) => normalize(route.path)));

    for (const path of documentedPaths()) {
      assert.ok(mounted.has(path), `${path} is documented but not mounted`);
    }
  });

  it('reads the route files it claims to check', async () => {
    // A static check that found no routes would pass the two tests above for the
    // wrong reason, so the list is asserted to be substantial and to contain a
    // route from each mounted family.
    const routes = await mountedRoutes();

    for (const path of ['/auth/login', '/drivers/me/availability', '/passengers/me/rides']) {
      assert.ok(
        routes.some((route) => normalize(route.path) === path),
        `${path} should have been found in the route files`,
      );
    }
  });
});

describe('the examples in the document', () => {
  it('uses the demo cast rather than placeholder names', () => {
    for (const placeholder of ['user1', 'driver1', 'alice', 'bob', 'example.com/user']) {
      assert.ok(
        !spec.toLowerCase().includes(placeholder),
        `the document must not use the placeholder "${placeholder}"`,
      );
    }

    // The seeded users, and the drivers and passengers the suite drives with.
    for (const name of ['Nusrat', 'Rafiq', 'Shirin', 'Jashim']) {
      assert.ok(spec.includes(name), `the document should show ${name} somewhere`);
    }
  });

  it('uses the seeded Banani data for its realistic values', () => {
    for (const code of ['banani-road-11', 'mohakhali-bus-terminal', 'banani-kakoli']) {
      assert.ok(spec.includes(code), `the document should use the seeded point ${code}`);
    }

    // The reference trip the README and the tests both use.
    assert.ok(spec.includes('2214'), 'the Banani → Mohakhali distance');
  });

  it('shows the money as strings, because that is what the API sends', () => {
    assert.match(spec, /fare: '130'/, 'the accepted solo fare, as a whole number of taka');
    assert.match(spec, /totalPassengerFare: '130'/, 'the pool total, as a string');
    // The components that explain a fare keep their decimals, which is what makes
    // the rounding visible rather than something a client has to infer.
    assert.match(spec, /unroundedFare: '126\.63'/, 'the fare before the unit rounding');
    assert.match(spec, /fareRoundingAdjustment: '3\.37'/, 'what the rounding moved');
  });

  it('documents the errors a client has to handle', () => {
    for (const code of ['BadRequest', 'Unauthenticated', 'WrongRole', 'NotFound']) {
      assert.ok(spec.includes(`${code}:`), `the shared ${code} response is missing`);
    }

    assert.ok(spec.includes("'400'"), 'a 400 is documented somewhere');
    assert.ok(spec.includes("'404'"), 'a 404 is documented somewhere');
    assert.ok(spec.includes("'409'"), 'a 409 is documented somewhere');
  });

  it('explains the pagination envelope it publishes', () => {
    for (const field of ['limit', 'offset', 'returned', 'total', 'hasMore']) {
      assert.ok(spec.includes(`${field}:`), `pagination.${field} is missing`);
    }

    assert.match(spec, /ORDER BY created_at DESC, id DESC/);
    assert.match(spec, /ORDER BY requested_at DESC, id DESC/);
  });

  it('states the empty states, which are the ones a client gets wrong', () => {
    assert.match(spec, /"ride": null/);
    assert.match(spec, /"pool": null/);
    assert.ok(spec.includes('ride: null') || spec.includes('pool: null'));
  });
});
