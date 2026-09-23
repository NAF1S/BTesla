import { ApiError } from '../utils/ApiError.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import * as users from './user.service.js';

/**
 * Verifies a login attempt.
 *
 * Returns the user record on success, or `null` for *every* failure: a wrong
 * password, an unknown identifier and a deactivated account are deliberately
 * indistinguishable to the caller, so nothing about account existence leaks.
 *
 * The password is verified before `active` is inspected, which keeps the
 * timings comparable and means a deactivated account costs the same as a wrong
 * password. `verifyPassword` also hashes a placeholder when there is no user,
 * for the same reason.
 */
export const authenticate = async (email, password) => {
  const user = await users.findForAuthentication(email);

  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? null);
  if (!user || !passwordMatches || !user.active) return null;

  // Only now -- after a verified password and an active account -- is the
  // login recorded.
  await users.touchLastLogin(user.id);

  return user;
};

/**
 * Public sign-up.
 *
 * Creates the account and the profile its role requires (in one transaction),
 * then hands back the freshly loaded user so the caller can start a session.
 *
 * `role` has already been restricted to the self-service roles by the
 * controller, so this can never mint an ADMIN.
 */
export const register = async ({ name, email, password, role }) => {
  // Checked up front for a clear message; the UNIQUE index on lower(email) is
  // still what actually guarantees it under concurrency, and a race would
  // surface as the same 409 through the error handler.
  const existing = await users.findByEmail(email);
  if (existing) throw new ApiError(409, 'An account with that email already exists');

  // Hashing is CPU-bound, so it happens before the transaction opens.
  const passwordHash = await hashPassword(password);

  const { id } = await users.createWithProfile({ name, email, passwordHash, role });
  return users.findCurrentUser(id);
};
