import { apiFetch, apiPost } from "./api";

/**
 * Who is signed in, and how they signed in.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN passenger-api.js OR driver-api.js
 * ---------------------------------------------------------------------------
 * The session is a property of the *person*, not of the role they use it in. A
 * driver and a passenger sign in through the same endpoint, get the same
 * HttpOnly cookie, and are described by the same DTO. If `signIn` lived in
 * `passenger-api.js`, the driver screens would have to import the passenger's
 * module to log in — which is exactly backwards, and the first thing a reviewer
 * would ask about.
 *
 * So: this module answers "who am I?", `passenger-api.js` answers "what may a
 * passenger do?", and `driver-api.js` answers "what may a driver do?".
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO TOKEN
 * ---------------------------------------------------------------------------
 * `POST /auth/login` sets an HttpOnly cookie and returns the user; the token is
 * never in the body and never anywhere JavaScript can read. There is therefore
 * nothing here to store, and no `localStorage` anywhere in this client. The
 * browser holds the session, and the only way to end it is `signOut`.
 */

/**
 * Signs a user in, whatever their role. Resolves to the signed-in user.
 *
 * The caller decides where they belong afterwards — from `user.role`, which is
 * read from the database on every request. This function deliberately does not
 * redirect: a module that knew where a role belongs would be a second copy of
 * the guard that lives in `session.js`.
 *
 * Every rejected attempt answers the same 401 with the same message, so the UI
 * cannot tell an unknown account from a wrong password — and must not try to.
 *
 * @param {{ email: string, password: string }} credentials
 * @returns {Promise<import("./types").SessionUser>}
 */
export const signIn = async ({ email, password }) => {
  const { user } = await apiPost("/auth/login", { email, password });
  return user;
};

/**
 * Creates an account for one of the two self-service roles, and signs it in.
 *
 * `role` is required rather than defaulted, so that a caller has to say which
 * kind of account it is creating. The server accepts only `PASSENGER` and
 * `DRIVER` — `ADMIN` is not a rejected value so much as an unaccepted one, so a
 * client cannot promote itself by adding a field.
 *
 * A new **driver** is created `OFFLINE` with no vehicle, and there is no
 * endpoint that creates a vehicle: such an account can sign in and read its own
 * availability, but dispatch cannot use it until an operator gives it a car. The
 * driver dashboard says so rather than offering a switch that cannot work.
 *
 * @param {{ name: string, email: string, password: string, role: "PASSENGER" | "DRIVER" }} account
 * @returns {Promise<import("./types").SessionUser>}
 */
export const signUp = async ({ name, email, password, role }) => {
  const { user } = await apiPost("/auth/register", { name, email, password, role });
  return user;
};

/**
 * Clears the cookie.
 *
 * The API answers `204` and does not require a valid token, so this is safe to
 * call on a stale session and safe to retry.
 *
 * @returns {Promise<void>}
 */
export const signOut = () => apiPost("/auth/logout");

/**
 * The current user, or `null` when there is no valid session.
 *
 * Used by the server-side guard, which passes the incoming cookie explicitly
 * because a Server Component has no ambient session.
 *
 * @param {{ cookie?: string }} [options]
 * @returns {Promise<import("./types").SessionUser | null>}
 */
export const getCurrentUser = async ({ cookie } = {}) => {
  try {
    const { user } = await apiFetch("/auth/me", { cookie });
    return user;
  } catch (error) {
    // A missing or expired session is the expected answer here, not a failure:
    // this call exists to ask "is anybody signed in?".
    if (error.status === 401) return null;
    throw error;
  }
};
