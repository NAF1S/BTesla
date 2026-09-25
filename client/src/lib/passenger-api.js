import { apiFetch, apiPost } from "./api";

/**
 * Every backend call this milestone's screens make, in one place.
 *
 * The point of this module is that **a screen never builds a URL**. A component
 * asks for "the zones" or "a quote between these two points" and gets a typed
 * object or an `ApiError`; the paths, the verbs, the body shapes and the header
 * names live here. That is what keeps the frontend thin, and it is what makes the
 * API's conventions visible in one file instead of scattered across pages.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY IS NEVER SENT
 * ---------------------------------------------------------------------------
 * No function here takes a passenger id, because no endpoint accepts one. The
 * session cookie identifies the caller, and every `/me` path resolves it on the
 * server. Creating a ride request sends exactly one field — a quote id that the
 * server issued, to this passenger, a moment earlier.
 *
 * ---------------------------------------------------------------------------
 * ONE COMPOSED CALL
 * ---------------------------------------------------------------------------
 * The API is quote-first: a ride request does not take a pickup and a
 * destination, it takes a **fare quote** for them. So `requestRide` asks for a
 * quote and then creates the request from it, which is the order the product
 * works in anyway — the passenger sees a price before they commit. Composing the
 * two here rather than in a component is what lets the screen say "request a ride
 * between these two places" and stay readable.
 */

// ---------------------------------------------------------------------------
// Authentication. The session is an HttpOnly cookie, so there is no token to
// store, read or attach — the browser holds it and JavaScript never sees it.
// ---------------------------------------------------------------------------

/**
 * Signs a passenger in. Resolves to the signed-in user.
 *
 * Every rejected attempt answers the same 401 and the same message, so the UI
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
 * Creates a passenger account and signs in, in one call.
 *
 * `role` is pinned to `PASSENGER` here rather than accepted from a caller: this
 * is the passenger client, and a sign-up screen with a role selector would be a
 * driver screen in disguise.
 *
 * @param {{ name: string, email: string, password: string }} account
 * @returns {Promise<import("./types").SessionUser>}
 */
export const signUp = async ({ name, email, password }) => {
  const { user } = await apiPost("/auth/register", {
    name,
    email,
    password,
    role: "PASSENGER",
  });
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

// ---------------------------------------------------------------------------
// Locations. Public endpoints, so they work before sign-in too.
// ---------------------------------------------------------------------------

/** Every active service area, for grouping the location dropdowns.
 * @returns {Promise<import("./types").Zone[]>}
 */
export const listZones = () => apiFetch("/location/zones");

/**
 * Every active service point, optionally narrowed to one zone.
 *
 * @param {{ zoneCode?: string }} [options]
 * @returns {Promise<import("./types").ServicePoint[]>}
 */
export const listServicePoints = ({ zoneCode } = {}) =>
  apiFetch(`/location/points${zoneCode ? `?zoneCode=${encodeURIComponent(zoneCode)}` : ""}`);

// ---------------------------------------------------------------------------
// Fares and rides
// ---------------------------------------------------------------------------

/**
 * Prices a solo journey between two service points.
 *
 * The API prices with exact decimals, a versioned policy and the traffic profile
 * of the departure instant, and it returns the arithmetic behind its answer. The
 * client displays `fare.finalFare` and calculates **nothing**: this project has
 * exactly one implementation of the fare rules and it is on the server.
 *
 * @param {{ originServicePointCode: string, destinationServicePointCode: string, departureAt?: string }} journey
 * @returns {Promise<import("./types").FareQuote>}
 */
export const quoteFare = (journey) =>
  apiPost("/fare-quotes", {
    originServicePointCode: journey.originServicePointCode,
    destinationServicePointCode: journey.destinationServicePointCode,
    ...(journey.departureAt ? { departureAt: journey.departureAt } : {}),
  });

/**
 * Creates a ride request from a quote the passenger owns.
 *
 * The `Idempotency-Key` is **required** and identifies one *intent*, not one
 * attempt: a retry of the same submission must reuse the key, or it creates a
 * second ride. `requestRide` below handles that; call this directly only if you
 * already hold a key.
 *
 * @param {{ fareQuoteId: string, idempotencyKey: string }} request
 * @returns {Promise<import("./types").RideRequestSummary>}
 */
export const createRideRequest = ({ fareQuoteId, idempotencyKey }) =>
  apiPost("/ride-requests", { fareQuoteId }, { headers: { "Idempotency-Key": idempotencyKey } });

/**
 * Quotes a journey and requests a ride for it, in one call.
 *
 * The idempotency key is derived from the journey itself, so submitting the same
 * two places twice is one ride while choosing different places is a new one. The
 * key is created here rather than by the caller because "what counts as the same
 * intent" is a property of this operation.
 *
 * ---------------------------------------------------------------------------
 * WHEN *NOT* TO USE THIS
 * ---------------------------------------------------------------------------
 * A screen that has already *shown* the passenger a price must not call this: the
 * quote it submits has to be the quote they agreed to, and this asks for a fresh
 * one. A quote is priced at an instant by a traffic profile, so quoting again at
 * submit time can return a different number from the one on screen. The ride
 * request panel therefore calls `quoteFare` and then `createRideRequest` with the
 * quote it is displaying. This exists for the case where nothing has been quoted
 * yet, and for tests.
 *
 * @param {{ originServicePointCode: string, destinationServicePointCode: string }} journey
 * @returns {Promise<import("./types").RideRequestSummary>}
 */
export const requestRide = async (journey) => {
  const quote = await quoteFare(journey);

  return createRideRequest({
    fareQuoteId: quote.quoteId,
    idempotencyKey: idempotencyKeyFor(journey),
  });
};

/**
 * A stable key for one journey.
 *
 * `crypto.randomUUID` is available in every browser this app supports and in Node
 * 18+. The fallback exists so a missing API cannot turn a required header into a
 * runtime crash, and it stays inside the 8–128 character limit the server
 * enforces.
 */
const idempotencyKeyFor = ({ originServicePointCode, destinationServicePointCode }) => {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return `ride-${originServicePointCode}-${destinationServicePointCode}-${suffix}`.slice(0, 128);
};

/**
 * The passenger's active ride, or `null`.
 *
 * A passenger who is not riding gets `null` rather than an error: not being on a
 * journey is the ordinary state, and the endpoint deliberately answers `200` with
 * `{ ride: null }` so a poller does not have to treat it as a failure.
 *
 * ---------------------------------------------------------------------------
 * WHAT "NO RIDE" DOES AND DOES NOT MEAN
 * ---------------------------------------------------------------------------
 * The endpoint answers with an **active** ride — `WAITING`, `MATCHED` or
 * `IN_PROGRESS` — or nothing at all. A ride that reached `COMPLETED` or
 * `CANCELLED` therefore arrives as `null`, not as a terminal status. A tracker can
 * see that the ride ended, but this call cannot say *which* way it ended; that is
 * the ride-detail endpoint's answer, and it belongs to a later milestone. Nothing
 * should be inferred from the absence — showing "cancelled" for a completed ride
 * would be a guess about the passenger's money.
 *
 * @param {{ cookie?: string }} [options]
 * @returns {Promise<import("./types").CurrentRide | null>}
 */
export const getCurrentRide = async ({ cookie } = {}) => {
  const { ride } = await apiFetch("/passengers/me/current-ride", { cookie });
  return ride ?? null;
};
