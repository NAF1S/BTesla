import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getCurrentUser } from "./passenger-api";

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
 * is going.
 *
 * So the guard runs while the page is being rendered, before any HTML exists. It
 * reads the incoming request's cookie, asks the API who that is, and redirects if
 * the answer is nobody. The cookie is forwarded by hand because a Server Component
 * has no ambient session: the browser's cookie reaches *this* server, and the API
 * is a different process.
 *
 * Note what this is not: it is not the authorization. The API checks the session
 * on every request regardless of what this module decided, and a page rendered
 * here still cannot read another passenger's ride. This guard exists so a signed
 * out visitor gets a sign-in form instead of an empty page.
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

/**
 * Where a passenger belongs once they are signed in.
 *
 * One constant rather than a string in four files: `page.js`, the two auth
 * screens and the layout all redirect here, and they must agree.
 */
export const PASSENGER_HOME = "/ride";

/**
 * Requires a signed-in **passenger**, and returns them.
 *
 * Three outcomes, and each is a different situation rather than a different
 * error:
 *
 *  * nobody is signed in -> the sign-in screen, remembering where they were
 *    going so the redirect can come back to it;
 *  * somebody is signed in but is not a passenger -> the sign-in screen with an
 *    explanation, because a driver account cannot use this client at all;
 *  * a passenger -> returned, with their `passengerProfile` id available.
 *
 * @param {{ redirectTo?: string }} [options]
 * @returns {Promise<import("./types").SessionUser>}
 */
export const requirePassenger = async ({ redirectTo } = {}) => {
  const user = await getSessionUser();

  if (!user) {
    const next = redirectTo ? `?next=${encodeURIComponent(redirectTo)}` : "";
    redirect(`/signin${next}`);
  }

  if (user.role !== "PASSENGER") {
    redirect(`/signin?denied=${encodeURIComponent(user.role.toLowerCase())}`);
  }

  return user;
};

/**
 * Sends a signed-in passenger away from the auth screens.
 *
 * Used by `/signin` and `/signup`: a passenger who already has a session has no
 * business on a sign-in form, and the brief asks for exactly this redirect.
 *
 * @returns {Promise<void>}
 */
export const redirectIfSignedIn = async ({ to = PASSENGER_HOME } = {}) => {
  const user = await getSessionUser();

  if (user?.role === "PASSENGER") redirect(to);
};
