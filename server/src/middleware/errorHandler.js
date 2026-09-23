import { env } from '../config/env.js';

// Postgres error codes -> HTTP status codes. Keys are quoted: SQLSTATE values
// like 22P02 are not valid JavaScript identifiers or numbers.
const PG_STATUS = {
  '23505': 409, // unique_violation
  '23502': 400, // not_null_violation
  '23503': 409, // foreign_key_violation
  '22P02': 400, // invalid_text_representation (e.g. a malformed UUID)
};

const PG_MESSAGES = {
  '23505': 'A record with those values already exists',
  '22P02': 'Malformed identifier',
};

// Express 5 forwards thrown/rejected errors here automatically.
export const errorHandler = (err, _req, res, _next) => {
  const mapped = PG_STATUS[err.code];
  if (mapped && !err.statusCode) {
    err.statusCode = mapped;
    err.message = PG_MESSAGES[err.code] ?? err.message;
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
