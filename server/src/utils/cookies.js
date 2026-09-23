import { env } from '../config/env.js';

/**
 * The authentication cookie.
 *
 * Attributes are defined once and shared by set and clear: a clearCookie call
 * whose attributes do not match the original Set-Cookie is ignored by the
 * browser, leaving the user still logged in.
 *
 *  * httpOnly  - JavaScript cannot read it, so XSS cannot exfiltrate the token
 *                (which is also why the token never goes to localStorage).
 *  * secure    - HTTPS only in production.
 *  * sameSite  - 'lax' by default, which suits the same-origin proxy setup.
 *                Changing it to 'none' requires secure cookies, so production
 *                cross-site use would also need COOKIE_SECURE=true.
 *  * path      - '/' so the cookie is sent for the whole API.
 */
const cookieAttributes = () => ({
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: env.cookieSameSite,
  path: '/',
});

const cookieName = () => env.authCookieName;

/** Issues the authentication cookie. `maxAge` mirrors the token's own expiry. */
export const setAuthCookie = (res, token) =>
  res.cookie(cookieName(), token, {
    ...cookieAttributes(),
    maxAge: env.authTokenTtlSeconds * 1000,
  });

/**
 * Removes the authentication cookie.
 *
 * Idempotent: clearing an already-absent cookie is a no-op, so logout is safe
 * to retry.
 */
export const clearAuthCookie = (res) => res.clearCookie(cookieName(), cookieAttributes());

/** The raw token from the request, or null. Requires cookie-parser. */
export const readAuthCookie = (req) => req.cookies?.[cookieName()] ?? null;
