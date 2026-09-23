import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { currentUser, requireRole } from '../../src/middleware/auth.js';

/**
 * Guard tests.
 *
 * `requireAuth` consults the database, so it is covered end-to-end by the API
 * integration suite instead. `requireRole` is pure, and is pinned down here --
 * including the passenger / driver / admin combinations the MVP's future rules
 * will depend on:
 *
 *   * a passenger may only reach their own ride requests;
 *   * a driver may only reach pools assigned to them;
 *   * only an admin may inspect system history.
 */

/** Runs a guard and reports whether it let the request through, or how it failed. */
const run = (guard, req) => {
  let called = false;
  try {
    guard(req, {}, () => {
      called = true;
    });
    return { called, status: null };
  } catch (err) {
    return { called, status: err.statusCode, message: err.message };
  }
};

describe('requireRole', () => {
  it('lets through a user whose role is allowed', () => {
    const result = run(requireRole('ADMIN'), { user: { role: 'ADMIN' } });

    assert.strictEqual(result.called, true);
    assert.strictEqual(result.status, null);
  });

  it('does not let a passenger reach a DRIVER-only resource', () => {
    const result = run(requireRole('DRIVER'), { user: { role: 'PASSENGER' } });

    assert.strictEqual(result.called, false);
    assert.strictEqual(result.status, 403);
  });

  it('does not let a driver reach a PASSENGER-only resource', () => {
    const result = run(requireRole('PASSENGER'), { user: { role: 'DRIVER' } });

    assert.strictEqual(result.called, false);
    assert.strictEqual(result.status, 403);
  });

  it('does not let passengers or drivers reach an ADMIN-only resource', () => {
    for (const role of ['PASSENGER', 'DRIVER']) {
      const result = run(requireRole('ADMIN'), { user: { role } });

      assert.strictEqual(result.called, false, `${role} must not reach an ADMIN-only resource`);
      assert.strictEqual(result.status, 403);
    }
  });

  it('accepts any of several allowed roles', () => {
    assert.strictEqual(run(requireRole('PASSENGER', 'DRIVER'), { user: { role: 'DRIVER' } }).called, true);
    assert.strictEqual(run(requireRole('PASSENGER', 'DRIVER'), { user: { role: 'PASSENGER' } }).called, true);

    const excluded = run(requireRole('PASSENGER', 'DRIVER'), { user: { role: 'ADMIN' } });
    assert.strictEqual(excluded.status, 403);
  });

  it('answers 401 when it runs without an authenticated user', () => {
    const result = run(requireRole('ADMIN'), {});

    assert.strictEqual(result.called, false);
    assert.strictEqual(result.status, 401);
  });
});

describe('currentUser', () => {
  it('returns the user attached to the request', () => {
    const user = { id: 'u1', role: 'PASSENGER' };

    assert.strictEqual(currentUser({ user }), user);
    assert.strictEqual(currentUser({}), undefined);
  });
});
