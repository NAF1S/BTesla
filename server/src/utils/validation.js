import { ApiError } from './ApiError.js';

/**
 * Stable codes are lower-case machine-readable values, matching the code
 * CHECK constraints in server/db/03-transport-network.sql.
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

/**
 * Rejects body fields the endpoint does not understand. Same idea as
 * assertQueryKeys, but for JSON payloads -- a client that sends `role` when
 * creating an account gets a 400 rather than having it silently ignored.
 */
export const assertBodyKeys = (body, allowedKeys) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Request body must be a JSON object');
  }

  const unknown = Object.keys(body).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      `Unsupported body field(s): ${unknown.join(', ')}. Supported: ${allowedKeys.join(', ') || 'none'}`,
    );
  }
};

// Deliberately permissive: the only authoritative checks on an address are that
// it is a single token and that it round-trips, not a regex arms race.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_EMAIL_LENGTH = 254;

/**
 * Trim + lower case, and nothing else. Pure and non-throwing, for callers that
 * already know the value is acceptable (the demo seeder, for example).
 */
export const normalizeEmail = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

/**
 * Normalises and validates the login identifier.
 *
 * Normalisation is trim + lower case, which is what keeps the identifier unique
 * in practice and matches the UNIQUE index on lower(email) in 04-auth.sql.
 * Callers must store and look up the *returned* value, never the raw input.
 */
export const requireEmail = (value, field = 'email') => {
  if (value === undefined || value === null) throw new ApiError(400, `${field} is required`);
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a string`);

  const email = normalizeEmail(value);
  if (email === '') throw new ApiError(400, `${field} must not be empty`);
  if (email.length > MAX_EMAIL_LENGTH) throw new ApiError(400, `${field} is too long`);
  if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, `${field} must be a valid email address`);

  return email;
};

/** Minimum length for a password chosen through sign-up. */
export const MIN_PASSWORD_LENGTH = 8;

const MAX_NAME_LENGTH = 120;

/**
 * Validates a password and returns it unchanged.
 *
 * Error messages never contain the submitted value, so a password cannot end up
 * in a response body or a log line through a validation failure.
 *
 * The 72-byte ceiling is bcrypt's own input limit: anything longer would be
 * silently ignored, so it is rejected instead.
 */
export const requirePassword = (value, field = 'password', { minLength = 1 } = {}) => {
  if (value === undefined || value === null) throw new ApiError(400, `${field} is required`);
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a string`);
  if (value.length < minLength) {
    throw new ApiError(400, `${field} must be at least ${minLength} characters`);
  }
  if (Buffer.byteLength(value, 'utf8') > 72) {
    throw new ApiError(400, `${field} must be at most 72 bytes`);
  }

  return value;
};

/**
 * Validates a display name and returns it trimmed.
 *
 * Trimming is the point: a name of only whitespace is not a name, and storing
 * the padding would make "Nusrat" and "Nusrat " look like two people.
 */
export const requireName = (value, field = 'name') => {
  if (value === undefined || value === null) throw new ApiError(400, `${field} is required`);
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a string`);

  const name = value.trim();
  if (name === '') throw new ApiError(400, `${field} must not be empty`);
  if (name.length > MAX_NAME_LENGTH) throw new ApiError(400, `${field} is too long`);

  return name;
};
