import { env } from '../config/env.js';

// PostgreSQL SQLSTATE -> HTTP status codes. Keys are quoted: values like 22P02
// are not valid JavaScript identifiers or numbers.
const SQLSTATE_STATUS = {
  '23505': 409, // unique_violation
  '23502': 400, // not_null_violation
  '23503': 409, // foreign_key_violation
  '23514': 400, // check_violation
  '22P02': 400, // invalid_text_representation (e.g. a malformed UUID)
};

// Messages are always replaced with a stable one so a driver-level message
// (long, and full of internals) never reaches the client.
const SQLSTATE_MESSAGES = {
  '23502': 'A required value is missing',
  '23503': 'Referenced record does not exist',
  '23505': 'A record with those values already exists',
  '23514': 'A value violates a database constraint',
  '22P02': 'Malformed identifier',
};

// Prisma's own error codes -> HTTP status codes.
const PRISMA_STATUS = {
  P2000: 400, // value too long for the column
  P2002: 409, // unique constraint failed
  P2003: 409, // foreign key constraint failed
  P2025: 404, // the record required by the operation does not exist
};

const PRISMA_MESSAGES = {
  P2000: 'A value is too long for its column',
  P2002: 'A record with those values already exists',
  P2003: 'Referenced record does not exist',
  P2025: 'Record not found',
};

/**
 * Raw SQL run through Prisma is reported as P2010 with the original SQLSTATE
 * nested inside the driver adapter error, so it is unwrapped here. That keeps
 * the same 400/409 behaviour the API had when it talked to PostgreSQL through
 * the pg driver directly.
 */
const sqlStateOf = (err) => err.meta?.driverAdapterError?.cause?.originalCode ?? null;

/** Translates a database error into `{ status, message }`, or null if unknown. */
const describeDatabaseError = (err) => {
  if (PRISMA_STATUS[err.code]) {
    return { status: PRISMA_STATUS[err.code], message: PRISMA_MESSAGES[err.code] };
  }

  const sqlState = SQLSTATE_STATUS[err.code] ? err.code : sqlStateOf(err);
  if (sqlState && SQLSTATE_STATUS[sqlState]) {
    return { status: SQLSTATE_STATUS[sqlState], message: SQLSTATE_MESSAGES[sqlState] };
  }

  return null;
};

// Express 5 forwards thrown/rejected errors here automatically.
export const errorHandler = (err, _req, res, _next) => {
  if (!err.statusCode) {
    const mapped = describeDatabaseError(err);
    if (mapped) {
      err.statusCode = mapped.status;
      err.message = mapped.message;
    }
  }

  const statusCode = err.statusCode ?? 500;

  if (statusCode >= 500) console.error('[api] unhandled error:', err);

  res.status(statusCode).json({
    error: {
      message: statusCode >= 500 && env.nodeEnv === 'production' ? 'Internal Server Error' : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
};
