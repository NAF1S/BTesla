import { env } from '../config/env.js';

// Express 5 forwards thrown/rejected errors here automatically.
export const errorHandler = (err, _req, res, _next) => {
  const statusCode = err.statusCode ?? 500;

  if (statusCode >= 500) console.error('[api] unhandled error:', err);

  res.status(statusCode).json({
    error: {
      message: statusCode >= 500 && env.nodeEnv === 'production' ? 'Internal Server Error' : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
};
