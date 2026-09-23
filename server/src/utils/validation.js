import { ApiError } from './ApiError.js';

/**
 * Stable codes are lower-case machine-readable values, matching the code
 * CHECK constraints in server/db/05-postgis-location.sql.
 */
export const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Validates a required code (path or query parameter) and normalises it.
 * Input is trimmed and lower-cased first, so "Banani" and "banani" both work.
 * Anything that is not a single well-formed code is a 400.
 */
export const requireCode = (value, field) => {
  if (value === undefined || value === null) throw new ApiError(400, `${field} is required`);
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a single value`);

  const code = value.trim().toLowerCase();
  if (code === '') throw new ApiError(400, `${field} must not be empty`);
  if (!CODE_PATTERN.test(code)) {
    throw new ApiError(400, `${field} must be a code of lower-case letters, digits, "-" or "_"`);
  }
  return code;
};

/** Same as requireCode, but an absent parameter is allowed and returned as null. */
export const optionalCode = (value, field) => (value === undefined ? null : requireCode(value, field));

/**
 * Rejects query parameters the endpoint does not understand, so typos surface
 * as a 400 instead of being silently ignored.
 */
export const assertQueryKeys = (query, allowedKeys) => {
  const unknown = Object.keys(query ?? {}).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      `Unsupported query parameter(s): ${unknown.join(', ')}. Supported: ${allowedKeys.join(', ') || 'none'}`,
    );
  }
};
