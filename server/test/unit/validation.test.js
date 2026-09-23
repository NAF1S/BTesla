import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../../src/utils/ApiError.js';
import { assertQueryKeys, optionalCode, requireCode } from '../../src/utils/validation.js';

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
