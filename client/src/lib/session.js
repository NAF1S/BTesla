import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getCurrentUser } from "./auth-api";
import { HOME_FOR_ROLE, ROLE, homeForRole } from "./roles";

/**
 * The session, resolved on the **server**.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GUARD IS HERE AND NOT IN THE BROWSER
 * ---------------------------------------------------------------------------
 * A client-side guard (`if (!user) router.replace("/signin")`) always ships the
 * protected markup to the browser first and then takes it away. The passenger
 * sees the screen for a moment, and — more to the point — anyone with developer
 * tools can read it. Neither is acceptable for a screen that shows where somebody
 * is going, or one that shows who is paying for it.
 *
 * So the guard runs while the page is being rendered, before any HTML exists. It
 * reads the incoming request's cookie, asks the API who that is, and redirects if
 * the answer is nobody. The cookie is forwarded by hand because a Server Component
 * has no ambient session: the browser's cookie reaches *this* server, and the API
 * is a different process.
 *
 * Note what this is not: it is not the authorization. The API checks the session
 * and the role on every request regardless of what this module decided, and a page
 * rendered here still cannot read another passenger's ride or another driver's
 * offers. This guard exists so a signed-out visitor gets a sign-in form instead of
 * an empty page, and so each role lands on the screen built for it.
 */

/**
 * The raw cookie header for this request, or `undefined`.
 *
 * Exported because a Server Component that wants to *read* something as the
 * passenger — the tracker's first render, for instance — needs the same thing the
 * guard does: the browser's cookie, forwarded to a different process by hand.
 */
export const readCookieHeader = async () => {
  const store = await cookies();
  const header = store.toString();

  return header === "" ? undefined : header;
};

/**
 * The signed-in user, or `null`.
 *
 * Never throws for "not signed in" — that is the ordinary answer, and the callers
 * below decide what to do about it.
 *
 * @returns {Promise<import("./types").SessionUser | null>}
 */
export const getSessionUser = async () =>
  getCurrentUser({ cookie: await readCookieHeader() });

/** Where a passenger belongs once they are signed in. */
export const PASSENGER_HOME = HOME_FOR_ROLE[ROLE.PASSENGER];

/** Where a driver belongs once they are signed in. */
export const DRIVER_HOME = HOME_FOR_ROLE[ROLE.DRIVER];

/**
 * Requires a signed-in user **of one role**, and returns them.
 *
 * Three outcomes, and each is a situation rather than an error:
 *
 *  * nobody is signed in -> the sign-in screen, remembering where they were going
 *    so the redirect can come back to it;
 *  * somebody is signed in, but as the *other* role -> **their own** home. This is
 *    the part that has to be right in a two-role client: a driver who lands on
 *    `/ride` must not be sent to the sign-in form, because they are already signed
 *    in and the form would send them back to `/ride` the moment they submitted
 *    it — a loop. They have a screen; send them to it;
 *  * somebody signed in as a role with no screen here (an `ADMIN`) -> the sign-in
 *    screen with an explanation, which is the one case the `denied` banner is for;
 *  * the right role -> returned, with their profile available.
 *
 * What this is *not* is authorization. The API checks the session and the role on
 * every request regardless of what this module decided.
 *
 * @param {string} role
 * @param {{ redirectTo?: string }} [options]
 * @returns {Promise<import("./types").SessionUser>}
 */
export const requireRole = async (role, { redirectTo } = {}) => {
  const user = await getSessionUser();

  if (!user) {
    const next = redirectTo ? `?next=${encodeURIComponent(redirectTo)}` : "";
    redirect(`/signin${next}`);
  }

  if (user.role !== role) {
    const home = homeForRole(user.role);
    redirect(home ?? `/signin?denied=${encodeURIComponent(user.role.toLowerCase())}`);
  }

  return user;
};

/**
 * Requires a signed-in **passenger**, and returns them.
 *
 * @param {{ redirectTo?: string }} [options]
 * @returns {Promise<import("./types").SessionUser>}
 */
export const requirePassenger = (options) => requireRole(ROLE.PASSENGER, options);

/**
 * Requires a signed-in **driver**, and returns them.
 *
 * A passenger who lands on `/driver` is sent to `/ride` rather than being told
 * they are not allowed — they have their own half of the app, and the session
 * they hold is valid.
 *
 * @param {{ redirectTo?: string }} [options]
 * @returns {Promise<import("./types").SessionUser>}
 */
export const requireDriver = (options) => requireRole(ROLE.DRIVER, options);

/**
 * Sends somebody who is already signed in away from the auth screens.
 *
 * Used by `/signin` and `/signup`. The destination is the role's home, so a
 * signed-in driver who opens the sign-in screen goes to their dashboard instead
 * of being shown a form that would sign them in again.
 *
 * A role with no home here (an admin) is left on the form: there is nowhere for
 * them to go, and `requireRole` will explain it if they try to open a screen.
 *
 * @returns {Promise<void>}
 */
export const redirectIfSignedIn = async ({ to } = {}) => {
  const user = await getSessionUser();
  if (!user) return;

  const destination = to ?? homeForRole(user.role);
  if (destination) redirect(destination);
};
