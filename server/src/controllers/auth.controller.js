import { Role } from '@prisma/client';

import { ApiError } from '../utils/ApiError.js';
import { toCurrentUserDto } from '../serializers/user.serializer.js';
import { clearAuthCookie, setAuthCookie } from '../utils/cookies.js';
import { signAuthToken } from '../utils/token.js';
import {
  assertBodyKeys,
  MIN_PASSWORD_LENGTH,
  requireEmail,
  requireName,
  requirePassword,
} from '../utils/validation.js';
import * as auth from '../services/auth.service.js';

/**
 * Authentication endpoints.
 *
 * Status-code convention, matching the rest of the API:
 *   400 - malformed request (including unknown body fields)
 *   401 - credentials rejected, or no valid authentication
 *   403 - authenticated but not permitted (see middleware/auth.js)
 *   409 - the request conflicts with existing state (an email already in use)
 *
 * Every rejected login returns the same message and status, so a caller cannot
 * tell an unknown account from a wrong password.
 */

/** Identical for every rejected login. */
const INVALID_CREDENTIALS = 'Invalid email or password';

const LOGIN_BODY_KEYS = ['email', 'password'];
const REGISTER_BODY_KEYS = ['name', 'email', 'password', 'role'];

/** The only roles a member of the public may create for themselves. */
const SELF_SERVICE_ROLES = [Role.PASSENGER, Role.DRIVER];

/**
 * Resolves the requested sign-up role, defaulting to PASSENGER.
 *
 * ADMIN is not simply refused by policy -- it is not an accepted value, so a
 * client cannot promote itself by adding a field to the request body.
 */
const signupRole = (value) => {
  if (value === undefined || value === null || value === '') return Role.PASSENGER;

  if (!SELF_SERVICE_ROLES.includes(value)) {
    throw new ApiError(400, `role must be one of ${SELF_SERVICE_ROLES.join(', ')}`);
  }

  return value;
};

export const login = async (req, res) => {
  assertBodyKeys(req.body, LOGIN_BODY_KEYS);
  const email = requireEmail(req.body.email);
  const password = requirePassword(req.body.password);

  const user = await auth.authenticate(email, password);
  if (!user) throw new ApiError(401, INVALID_CREDENTIALS);

  // The token goes out only as an HttpOnly cookie -- never in the body, and
  // never anywhere JavaScript (or localStorage) could read it.
  setAuthCookie(res, signAuthToken(user.id));

  res.json({ user: toCurrentUserDto(user) });
};

/**
 * Public sign-up for the two self-service roles.
 *
 * The new account is signed in immediately, exactly as login does, so the
 * client does not have to follow up with a second request. The role decides
 * which profile is created: a PASSENGER gets a passenger profile, a DRIVER gets
 * a driver profile (starting OFFLINE, with no vehicle).
 */
export const register = async (req, res) => {
  assertBodyKeys(req.body, REGISTER_BODY_KEYS);

  const name = requireName(req.body.name);
  const email = requireEmail(req.body.email);
  const password = requirePassword(req.body.password, 'password', {
    minLength: MIN_PASSWORD_LENGTH,
  });
  const role = signupRole(req.body.role);

  const user = await auth.register({ name, email, password, role });

  setAuthCookie(res, signAuthToken(user.id));

  res.status(201).json({ user: toCurrentUserDto(user) });
};

/**
 * The current user.
 *
 * `req.user` was loaded from the database by requireAuth, so this reflects
 * current reality rather than anything the client asserted.
 */
export const me = async (req, res) => {
  res.json({ user: toCurrentUserDto(req.user) });
};

/**
 * Logout.
 *
 * Deliberately does not require a valid token: an expired or already-removed
 * cookie must still be clearable, which is also what makes logout safe to
 * retry. Clearing the cookie is the whole of the invalidation -- the token is
 * stateless and remains technically valid until it expires (see README).
 */
export const logout = async (_req, res) => {
  clearAuthCookie(res);
  res.status(204).end();
};
