import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { errorHandler } from '../../src/middleware/errorHandler.js';
import { ApiError } from '../../src/utils/ApiError.js';

/**
 * The error handler is the single place that decides what a failed request
 * looks like, so the 400 / 404 / 409 contract is asserted here.
 */

/** Invokes the handler with a fake response and returns what it produced. */
const handle = (err) => {
  const captured = {};
  const res = {
    status(code) {
      captured.status = code;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };

  errorHandler(err, { method: 'GET', originalUrl: '/api/location' }, res, () => {});
  return captured;
};

describe('errorHandler', () => {
  it('passes an ApiError through unchanged', () => {
    const { status, body } = handle(new ApiError(404, 'Stop "nope" was not found'));

    assert.strictEqual(status, 404);
    assert.deepStrictEqual(body, { error: { message: 'Stop "nope" was not found' } });
  });

  it('includes details when they are provided', () => {
    const { status, body } = handle(new ApiError(400, 'Invalid query', { field: 'zoneCode' }));

    assert.strictEqual(status, 400);
    assert.deepStrictEqual(body, {
      error: { message: 'Invalid query', details: { field: 'zoneCode' } },
    });
  });

  it('maps PostgreSQL conflicts to 409', () => {
    const unique = handle(Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }));
    assert.strictEqual(unique.status, 409);
    assert.strictEqual(unique.body.error.message, 'A record with those values already exists');

    const foreignKey = handle(Object.assign(new Error('violates foreign key constraint'), { code: '23503' }));
    assert.strictEqual(foreignKey.status, 409);
    assert.strictEqual(foreignKey.body.error.message, 'Referenced record does not exist');
  });

  it('maps Prisma error codes to the same statuses', () => {
    const unique = handle(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    assert.strictEqual(unique.status, 409);
    assert.strictEqual(unique.body.error.message, 'A record with those values already exists');

    const foreignKey = handle(Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' }));
    assert.strictEqual(foreignKey.status, 409);
    assert.strictEqual(foreignKey.body.error.message, 'Referenced record does not exist');

    const missing = handle(
      Object.assign(new Error('An operation failed because a required record was not found'), {
        code: 'P2025',
      }),
    );
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body.error.message, 'Record not found');
  });

  it('unwraps the SQLSTATE that Prisma nests inside raw-SQL errors', () => {
    const check = handle(
      Object.assign(new Error('Invalid `prisma.$executeRawUnsafe()` invocation'), {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '23514' } } },
      }),
    );

    assert.strictEqual(check.status, 400);
    assert.strictEqual(check.body.error.message, 'A value violates a database constraint');
  });

  it('maps PostgreSQL input errors to 400', () => {
    const nullViolation = handle(Object.assign(new Error('null value in column'), { code: '23502' }));
    assert.strictEqual(nullViolation.status, 400);

    const malformed = handle(Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }));
    assert.strictEqual(malformed.status, 400);
    assert.strictEqual(malformed.body.error.message, 'Malformed identifier');
  });

  it('does not overwrite a status code that was already set', () => {
    const err = Object.assign(new Error('conflict'), { code: '23505', statusCode: 400 });
    const { status, body } = handle(err);

    assert.strictEqual(status, 400);
    assert.strictEqual(body.error.message, 'conflict');
  });

  it('returns 500 for unexpected errors', () => {
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const { status, body } = handle(new Error('boom'));

      assert.strictEqual(status, 500);
      assert.strictEqual(body.error.message, 'boom');
    } finally {
      console.error = originalConsoleError;
    }
  });
});
