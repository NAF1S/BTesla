import { apiFetch, apiPatch, apiPost } from "./api";

/**
 * Every backend call a **driver's** screen makes, in one place.
 *
 * Same rule as the passenger's module: a screen never builds a URL. A component
 * asks "am I online?", "what am I being offered?" or "take this offer", and gets
 * an object or an `ApiError`.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY IS NEVER SENT
 * ---------------------------------------------------------------------------
 * Nothing here takes a driver id. The session cookie identifies the caller and
 * every `/me` path resolves it on the server, so "another driver's availability"
 * is not an addressable resource. The **only** identifier a driver's client ever
 * sends is an offer id — and an offer that belongs to somebody else answers
 * `404`, the same as one that does not exist, so it cannot be used to discover
 * another driver's work.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS THIS MODULE DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 * **Whether a button is available.** `canGoOnline`, `canGoOffline` and the
 * offer's own `expired` flag come from the server, computed from the same rules
 * the write endpoints consult. A client that worked them out from `status` would
 * be a second copy of the state machine, and the one that is wrong sometimes.
 *
 * **What happens on acceptance.** `acceptOffer` sends an offer id and *no body*:
 * the plan the driver is accepting is the one that was stored when the offer was
 * made, so there is nothing for a client to submit and nothing for it to edit.
 * The pool that comes back is the server's answer, not the client's idea of one.
 *
 * ---------------------------------------------------------------------------
 * TWO DRIVER ENDPOINTS ARE DELIBERATELY NOT WRAPPED HERE
 * ---------------------------------------------------------------------------
 * `PUT /drivers/me/current-service-point` (move while offline or available) and
 * `GET /drivers/me/offers/:offerId` (one offer on its own) both exist and work.
 * No screen calls either, and a wrapper nothing calls is dead code that reads as a
 * capability — so they are named here instead of exported:
 *
 *  * **moving** has no control because the availability DTO publishes no boolean
 *    for it. `canSetCurrentServicePoint` is a server rule, and deciding it in the
 *    browser from `status` would be a second copy of it. A driver who wants to
 *    relocate goes offline and comes online somewhere else — two clicks, no rule.
 *  * **one offer** needs no call because the list already carries everything the
 *    card renders: the server builds both from the same `toOfferDto`.
 */

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * The driver's own availability: status, the place they are at, their vehicles,
 * and the two booleans saying which way they may move.
 *
 * `online` is the boolean a switch binds to; `canGoOnline` / `canGoOffline` are
 * what decide whether that switch is enabled. They are separate facts: a
 * `RESERVED` driver is online and yet may not go offline, because they have
 * accepted a passenger.
 *
 * @param {{ cookie?: string }} [options]
 * @returns {Promise<import("./types").DriverAvailability>}
 */
export const getAvailability = ({ cookie } = {}) =>
  apiFetch("/drivers/me/availability", { cookie });

/**
 * The one availability write, in both directions.
 *
 * `PATCH` rather than the older `POST /me/online` and `POST /me/offline` pair:
 * there is one endpoint for the toggle, and it is the one the API documents for
 * clients. Going **online** needs a place to be — the dispatcher routes from a
 * service point, and a driver with no point can never be a candidate. Going
 * **offline** needs nothing: a driver who is offline is not anywhere as far as
 * dispatch is concerned.
 *
 * `operationalStatus` is deliberately not sendable. `RESERVED` and `ON_RIDE` are
 * facts that accepting a ride and departing establish, and a device that could
 * set them could make itself dispatchable while carrying a passenger.
 *
 * @param {{ online: boolean, servicePointCode?: string, vehicleId?: string }} availability
 * @returns {Promise<import("./types").DriverAvailability>}
 */
export const setAvailability = ({ online, servicePointCode, vehicleId }) =>
  apiPatch("/drivers/me/availability", {
    online,
    ...(servicePointCode ? { servicePointCode } : {}),
    ...(vehicleId ? { vehicleId } : {}),
  });

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

/**
 * The offers this driver can act on: pending by default, `"ALL"` for history.
 *
 * ---------------------------------------------------------------------------
 * THIS CALL IS ALSO THE HEARTBEAT
 * ---------------------------------------------------------------------------
 * `lastSeenAt` is refreshed when a driver goes online, moves, **reads their
 * offers**, or answers one — the moments the server learns they are still there.
 * A location older than the freshness window (300 s by default) makes the driver
 * ineligible for dispatch, because a location that cannot be trusted is not one
 * the server can promise a passenger.
 *
 * So a dashboard that polls this keeps its driver dispatchable, and one that
 * simply goes online and sits still stops being a candidate after five minutes.
 * That is a property of the API, not a trick: it is the only signal this project
 * has that a driver is still at the wheel, until a GPS milestone replaces it.
 *
 * @param {{ status?: import("./types").OfferStatus | "ALL", limit?: number, cookie?: string }} [options]
 * @returns {Promise<import("./types").DispatchOffer[]>}
 */
export const listOffers = ({ status = "PENDING", limit, cookie } = {}) =>
  apiFetch(
    `/drivers/me/offers?status=${encodeURIComponent(status)}${limit ? `&limit=${limit}` : ""}`,
    { cookie },
  );

/**
 * Accepts an offer and resolves to the **pool** it created.
 *
 * Takes no body, on purpose: the plan is the one that was offered. Acceptance is
 * the largest write in the project — a pool, a member, two stops, a request that
 * stops waiting, a driver who stops being available, an offer that ends and six
 * audit events — and it is all one transaction, so a half-matched ride cannot
 * exist.
 *
 * The failures a caller must handle are not network failures: `404` if the offer
 * is not theirs, `409` if it expired or was already answered or the driver is
 * committed elsewhere. All of them mean "re-read your offers", which is what the
 * console does rather than retrying.
 *
 * @param {{ offerId: string }} offer
 * @returns {Promise<import("./types").DriverPool>}
 */
export const acceptOffer = ({ offerId }) => apiPost(`/drivers/me/offers/${offerId}/accept`, {});

/**
 * Refuses an offer, recording why.
 *
 * The reason is one of the four the product defines, and it is not decoration:
 * dispatch scores a driver partly on how recently they refused, so the refusal is
 * an input to the next decision. A reason the client invented would be a value
 * the server refuses with a `400`.
 *
 * The pool — if any — is left exactly as it was, and the request is passed to the
 * next candidate in the same call, so the passenger keeps waiting rather than
 * being stranded.
 *
 * @param {{ offerId: string, reason?: import("./types").RejectionReason }} refusal
 * @returns {Promise<{ offerId: string, status: string, rejectionReason: string | null }>}
 */
export const rejectOffer = ({ offerId, reason }) =>
  apiPost(`/drivers/me/offers/${offerId}/reject`, reason ? { reason } : {});

// ---------------------------------------------------------------------------
// The pool the driver is committed to
// ---------------------------------------------------------------------------

/**
 * The pool this driver is committed to, or `null`.
 *
 * No pool is not an error and not an empty result to be apologised for: an
 * available driver has none, and neither has one whose trip has finished. It is
 * the same shape as the passenger's `current-ride` — one row a client polls, and
 * `null` is an ordinary answer rather than a `404`.
 *
 * The DTO carries `allowedActions`, computed from the state by the same rules the
 * trip commands consult. This milestone does not *offer* those commands — the
 * trip execution UI is the next one — but the summary shows what the server says
 * the driver may do, so the screen never has to guess.
 *
 * @param {{ cookie?: string }} [options]
 * @returns {Promise<import("./types").DriverPool | null>}
 */
export const getCurrentPool = async ({ cookie } = {}) => {
  const { pool } = await apiFetch("/drivers/me/current-pool", { cookie });
  return pool ?? null;
};
