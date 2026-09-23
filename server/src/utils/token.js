import jwt from 'jsonwebtoken';

import { env } from '../config/env.js';

/**
 * Authentication tokens: a signed JWT carried in an HttpOnly cookie.
 *
 * The payload deliberately contains only the subject (the user id) plus the
 * standard timestamps. It does NOT carry the role or the profile, because
 * nothing here is trusted for authorization: `requireAuth` re-loads the user
 * from the database on every request. That is what makes an inactive or
 * re-roled user take effect immediately rather than at token expiry.
 */

export const signAuthToken = (userId) =>
  jwt.sign({}, env.jwtSecret, { subject: userId, expiresIn: env.authTokenTtlSeconds });

/**
 * Verifies a token and returns its subject, or `null` when it is missing,
 * malformed, expired, or signed with the wrong key.
 *
 * All of those collapse into a single outcome on purpose: the caller must not
 * be able to tell them apart, and should answer with one generic 401.
 */
export const verifyAuthToken = (token) => {
  if (typeof token !== 'string' || token === '') return null;

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    return typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : null;
  } catch {
    return null;
  }
};
