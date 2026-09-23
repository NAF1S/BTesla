import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashPassword, verifyPassword } from '../../src/utils/password.js';

/**
 * The password helpers are the only place a password is turned into something
 * storable, and the only place a login is verified. These tests pin down that
 * it is an adaptive hash, that it is salted, and that verification never throws
 * and never succeeds by accident.
 */

const PLAIN = 'DemoPass123!';

describe('hashPassword', () => {
  it('stores an adaptive bcrypt hash rather than the password', async () => {
    const hash = await hashPassword(PLAIN);

    assert.notStrictEqual(hash, PLAIN);
    assert.ok(!hash.includes(PLAIN), 'the hash must not contain the password');
    assert.match(hash, /^\$2[aby]\$\d{2}\$/, 'expected a bcrypt hash');
  });

  it('salts every hash, so the same password never hashes the same way twice', async () => {
    const [first, second] = await Promise.all([hashPassword(PLAIN), hashPassword(PLAIN)]);

    assert.notStrictEqual(first, second, 'two hashes of one password must differ');
    assert.ok(await verifyPassword(PLAIN, first));
    assert.ok(await verifyPassword(PLAIN, second));
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword(PLAIN);

    assert.strictEqual(await verifyPassword(PLAIN, hash), true);
    assert.strictEqual(await verifyPassword('wrong-password', hash), false);
    assert.strictEqual(await verifyPassword(`${PLAIN} `, hash), false, 'trailing space must not match');
  });

  it('returns false rather than throwing for a missing or malformed hash', async () => {
    // A NULL hash means the account has no credentials, so it simply cannot log
    // in. The important part is that nothing throws.
    for (const hash of [null, undefined, '', 'not-a-hash-at-all', '$2b$10$tooshort']) {
      assert.strictEqual(await verifyPassword(PLAIN, hash), false, `hash ${String(hash)} must not verify`);
    }
  });

  it('returns false for a non-string password', async () => {
    const hash = await hashPassword(PLAIN);

    for (const password of [null, undefined, '', 42, {}, []]) {
      assert.strictEqual(await verifyPassword(password, hash), false);
    }
  });
});
