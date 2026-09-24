import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../../src/utils/ApiError.js';
import {
  assertQueryKeys,
  MIN_PASSWORD_LENGTH,
  optionalCode,
  optionalIsoTimestamp,
  requireCode,
  requireEmail,
  requireIsoTimestamp,
  requireName,
  requirePassword,
} from '../../src/utils/validation.js';

/** Runs `fn` and returns the ApiError it must throw. */
const catchApiError = (fn, expectedStatus) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${err.name}`);
    assert.strictEqual(err.statusCode, expectedStatus);
    return err;
  }
  assert.fail(`expected an ApiError with status ${expectedStatus}`);
};

describe('requireCode', () => {
  it('accepts and normalises a stable code', () => {
    assert.strictEqual(requireCode('banani', 'zoneCode'), 'banani');
    assert.strictEqual(requireCode('  Banani  ', 'zoneCode'), 'banani');
    assert.strictEqual(requireCode('banani-road-11', 'code'), 'banani-road-11');
    assert.strictEqual(requireCode('mohakhali_2', 'code'), 'mohakhali_2');
  });

  it('rejects missing, empty and repeated values', () => {
    assert.match(catchApiError(() => requireCode(undefined, 'zoneCode'), 400).message, /required/);
    assert.match(catchApiError(() => requireCode('', 'zoneCode'), 400).message, /must not be empty/);
    assert.match(catchApiError(() => requireCode('   ', 'zoneCode'), 400).message, /must not be empty/);
    assert.match(
      catchApiError(() => requireCode(['banani', 'gulshan'], 'zoneCode'), 400).message,
      /single value/,
    );
  });

  it('rejects malformed code formats', () => {
    assert.strictEqual(requireCode('a'.repeat(64), 'code').length, 64);
    catchApiError(() => requireCode('a'.repeat(65), 'code'), 400);
    catchApiError(() => requireCode('-banani', 'code'), 400);
    catchApiError(() => requireCode('banani road', 'code'), 400);
    catchApiError(() => requireCode('banani!', 'code'), 400);
  });
});

describe('optionalCode', () => {
  it('returns null when the parameter is absent', () => {
    assert.strictEqual(optionalCode(undefined, 'zoneCode'), null);
  });

  it('validates the value when it is present', () => {
    assert.strictEqual(optionalCode('Gulshan', 'zoneCode'), 'gulshan');
    assert.match(catchApiError(() => optionalCode('', 'zoneCode'), 400).message, /must not be empty/);
    catchApiError(() => optionalCode('not a code', 'zoneCode'), 400);
  });
});

describe('assertQueryKeys', () => {
  it('accepts supported parameters', () => {
    assert.doesNotThrow(() => assertQueryKeys({ zoneCode: 'banani' }, ['zoneCode']));
    assert.doesNotThrow(() => assertQueryKeys({}, ['zoneCode']));
  });

  it('rejects unsupported parameters and names them', () => {
    const err = catchApiError(
      () => assertQueryKeys({ zoneCode: 'banani', page: '2' }, ['zoneCode']),
      400,
    );
    assert.match(err.message, /page/);
    assert.match(err.message, /zoneCode/);
  });
});

describe('requireEmail', () => {
  it('normalises case and padding, returning the form that gets stored', () => {
    assert.strictEqual(requireEmail('  Nusrat@Example.COM '), 'nusrat@example.com');
  });

  it('rejects missing, empty, malformed, over-long and non-string values', () => {
    assert.match(catchApiError(() => requireEmail(undefined), 400).message, /required/);
    assert.match(catchApiError(() => requireEmail('   '), 400).message, /must not be empty/);
    assert.match(catchApiError(() => requireEmail('nope'), 400).message, /valid email/);
    assert.match(catchApiError(() => requireEmail('a@b'), 400).message, /valid email/);
    assert.match(catchApiError(() => requireEmail(42), 400).message, /must be a string/);
    catchApiError(() => requireEmail(`${'a'.repeat(250)}@example.com`), 400);
  });
});

describe('requireName', () => {
  it('trims the name it returns', () => {
    assert.strictEqual(requireName('  Nusrat  '), 'Nusrat');
  });

  it('rejects missing, blank, non-string and over-long names', () => {
    assert.match(catchApiError(() => requireName(undefined), 400).message, /required/);
    assert.match(catchApiError(() => requireName('   '), 400).message, /must not be empty/);
    assert.match(catchApiError(() => requireName(42), 400).message, /must be a string/);
    catchApiError(() => requireName('a'.repeat(121)), 400);
  });
});

describe('requirePassword', () => {
  it('accepts the minimum length and rejects one character fewer', () => {
    const password = 'a'.repeat(MIN_PASSWORD_LENGTH);
    const options = { minLength: MIN_PASSWORD_LENGTH };

    assert.strictEqual(requirePassword(password, 'password', options), password);

    const err = catchApiError(
      () => requirePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1), 'password', options),
      400,
    );
    assert.match(err.message, new RegExp(`at least ${MIN_PASSWORD_LENGTH}`));
  });

  it('never echoes the submitted password in an error', () => {
    const secret = 'short';
    const err = catchApiError(() => requirePassword(secret, 'password', { minLength: 8 }), 400);

    assert.ok(!err.message.includes(secret), 'the password must not appear in the message');
  });

  it('rejects a password beyond the 72-byte bcrypt limit', () => {
    assert.strictEqual(requirePassword('a'.repeat(72)).length, 72);
    catchApiError(() => requirePassword('a'.repeat(73)), 400);
  });
});

describe('requireIsoTimestamp', () => {
  it('accepts ISO 8601 instants with an offset and returns the instant', () => {
    assert.strictEqual(
      requireIsoTimestamp('2026-09-24T08:41:00+06:00', 'departureAt').toISOString(),
      '2026-09-24T02:41:00.000Z',
    );
    assert.strictEqual(
      requireIsoTimestamp('2026-09-24T02:41:00Z', 'departureAt').toISOString(),
      '2026-09-24T02:41:00.000Z',
    );
    assert.strictEqual(
      requireIsoTimestamp('2026-09-24T08:41+06:00', 'departureAt').toISOString(),
      '2026-09-24T02:41:00.000Z',
    );
    assert.strictEqual(
      requireIsoTimestamp('2026-09-24T02:41:00.250Z', 'departureAt').getTime() % 1000,
      250,
    );
  });

  it('rejects a missing or non-string value', () => {
    assert.match(
      catchApiError(() => requireIsoTimestamp(undefined, 'departureAt'), 400).message,
      /required/,
    );
    assert.match(
      catchApiError(() => requireIsoTimestamp(null, 'departureAt'), 400).message,
      /required/,
    );
    assert.match(
      catchApiError(() => requireIsoTimestamp(1_760_000_000_000, 'departureAt'), 400).message,
      /ISO 8601 timestamp string/,
    );
  });

  it('rejects timestamps with no offset, because the instant would be ambiguous', () => {
    assert.match(
      catchApiError(() => requireIsoTimestamp('2026-09-24T08:41', 'departureAt'), 400).message,
      /explicit offset/,
    );
    assert.match(
      catchApiError(() => requireIsoTimestamp('2026-09-24 08:41', 'departureAt'), 400).message,
      /explicit offset/,
    );
    assert.match(
      catchApiError(() => requireIsoTimestamp('2026-09-24', 'departureAt'), 400).message,
      /explicit offset/,
    );
  });

  it('rejects values that look like timestamps but are not real instants', () => {
    for (const value of [
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-09-24T25:00:00Z',
      '2026-09-24T08:41:00+24:00',
      'yesterday',
      '',
    ]) {
      catchApiError(() => requireIsoTimestamp(value, 'departureAt'), 400);
    }
  });

  it('names the offending field in the message', () => {
    const err = catchApiError(() => requireIsoTimestamp('not a timestamp', 'departureAt'), 400);
    assert.match(err.message, /^departureAt /);
  });
});

describe('optionalIsoTimestamp', () => {
  it('treats an absent field as absent, and an explicit null as invalid', () => {
    assert.strictEqual(optionalIsoTimestamp(undefined, 'departureAt'), null);
    catchApiError(() => optionalIsoTimestamp(null, 'departureAt'), 400);
  });

  it('validates the value when it is present', () => {
    assert.strictEqual(
      optionalIsoTimestamp('2026-09-24T08:41:00+06:00', 'departureAt').toISOString(),
      '2026-09-24T02:41:00.000Z',
    );
    catchApiError(() => optionalIsoTimestamp('later', 'departureAt'), 400);
  });
});
