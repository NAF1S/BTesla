/**
 * The roles, and where each of them lives.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE
 * ---------------------------------------------------------------------------
 * Three very different places need this answer and they must not disagree:
 *
 *  * `session.js` — the server-side guard, which decides whether to redirect and
 *    where to;
 *  * the sign-in form — a **client** component, which has to send a driver to the
 *    driver's area the moment the API tells it who just signed in;
 *  * `app/page.js` — the front door, which redirects by role.
 *
 * `session.js` imports `next/headers` and therefore cannot be imported from a
 * client component at all. Keeping the mapping here means the client can use it
 * without pulling the guard into the browser bundle — and means "a driver belongs
 * at /driver" is written down exactly once.
 *
 * These strings are the API's own values (`Role` in the Prisma schema). They are
 * never derived from the client, and never sent by it: `role` is read from the
 * database on every request.
 */

/** The value the API uses for each role. Not a display name. */
export const ROLE = Object.freeze({
  PASSENGER: "PASSENGER",
  DRIVER: "DRIVER",
  ADMIN: "ADMIN",
});

/**
 * Where a role belongs once it is signed in.
 *
 * `ADMIN` deliberately has no entry. There is no administrative screen in this
 * client, and inventing a home for a role that has none would be a route that
 * exists only to 403.
 *
 * @type {Record<string, string>}
 */
export const HOME_FOR_ROLE = Object.freeze({
  [ROLE.PASSENGER]: "/ride",
  [ROLE.DRIVER]: "/driver",
});

/** The home of a role, or `null` when this client has no screen for it. */
export const homeForRole = (role) => HOME_FOR_ROLE[role] ?? null;
