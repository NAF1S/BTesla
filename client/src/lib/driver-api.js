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
 * The DTO carries `allowedActions` and `nextStop`, both computed from the state by
 * the same rules the trip commands consult. Those two fields are the entire basis
 * for the trip controls: this client never decides which command is legal.
 *
 * @param {{ cookie?: string }} [options]
 * @returns {Promise<import("./types").DriverPool | null>}
 */
export const getCurrentPool = async ({ cookie } = {}) => {
  const { pool } = await apiFetch("/drivers/me/current-pool", { cookie });
  return pool ?? null;
};

// ---------------------------------------------------------------------------
// Driving the trip: the six commands
// ---------------------------------------------------------------------------
//
// Every one takes **no body**, and every identifier is in the path. That is the
// API's design, not a convention this file invented: a trip command says "this
// happened", and a timestamp, a seat count or a driver sent in a body would all be
// something to validate, or worse, to trust. `assertBodyKeys` with no allowed keys
// makes a supplied field a `400` rather than a silent no-op.
//
// Idempotency is state, not a key: sending the same command twice returns the state
// it produced the first time, with no second event and no timestamp moved. So a
// retry after a timeout is safe, and nothing here needs an idempotency key.
//
// Each resolves to the pool as it now stands. The command runs and the pool is
// re-read inside the same request, because completing a trip is exactly the
// operation that stops a pool being "current" — and the driver still has to be told
// how it ended.
//
// The six are **module-private on purpose**: a screen names an action from
// `allowedActions` and calls `runTripAction`, so exporting a second way to reach the
// same URL would be surface nothing uses and a second thing to keep honest.

/** The one URL shape every trip command shares. */
const postPoolCommand = async (poolId, path) => {
  const { pool } = await apiPost(`/drivers/me/pools/${poolId}/${path}`, {});
  return pool;
};

/**
 * Set off. Closes the pool to matching, freezes the fare, and puts the driver on
 * the ride.
 *
 * @param {{ poolId: string }} command
 * @returns {Promise<import("./types").DriverPool>}
 */
const departPool = ({ poolId }) => postPoolCommand(poolId, "depart");

/**
 * Mark arrival at one stop, in order. A later stop cannot be reached first.
 *
 * @param {{ poolId: string, stopId: string }} command
 * @returns {Promise<import("./types").DriverPool>}
 */
const arriveAtStop = ({ poolId, stopId }) =>
  postPoolCommand(poolId, `stops/${stopId}/arrive`);

/**
 * Collect one passenger, at *their* stop. At a shared corner the stop stays open
 * until every passenger there is aboard.
 *
 * @param {{ poolId: string, stopId: string, memberId: string }} command
 * @returns {Promise<import("./types").DriverPool>}
 */
const pickUpMember = ({ poolId, stopId, memberId }) =>
  postPoolCommand(poolId, `stops/${stopId}/members/${memberId}/pickup`);

/**
 * Begin the trip proper, once at least one passenger is aboard.
 *
 * A passenger still waiting further along keeps their `MATCHED` ride and is
 * collected during the trip — starting is not "everybody is in the car".
 *
 * @param {{ poolId: string }} command
 * @returns {Promise<import("./types").DriverPool>}
 */
const startTrip = ({ poolId }) => postPoolCommand(poolId, "start");

/**
 * Deliver one passenger. Completes *their* ride and leaves the pool running for
 * anybody else in the car.
 *
 * @param {{ poolId: string, stopId: string, memberId: string }} command
 * @returns {Promise<import("./types").DriverPool>}
 */
const dropOffMember = ({ poolId, stopId, memberId }) =>
  postPoolCommand(poolId, `stops/${stopId}/members/${memberId}/dropoff`);

/**
 * Finish the trip, which releases the driver back to `AVAILABLE`.
 *
 * Refused while any stop is unfinished or anybody is still in the car, so the
 * server will not let a driver complete a ride they have not delivered.
 *
 * @param {{ poolId: string }} command
 * @returns {Promise<import("./types").DriverPool>}
 */
const completeTrip = ({ poolId }) => postPoolCommand(poolId, "complete");

/**
 * The stop a command acts on, and the passenger at it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LOOKUP IS NEEDED, AND WHY IT IS NOT A RULE
 * ---------------------------------------------------------------------------
 * `allowedActions` names what may be done but is not *addressable*: it says
 * `PICKUP_PASSENGER`, not which stop or which member, because the server already
 * knows. The pool publishes the two halves — `nextStop` ("the lowest-sequence stop
 * that is not done: where the driver goes next, and the only stop they may serve")
 * and each member's own `stops` — so this joins them.
 *
 * It is a **lookup of published ids, not a derivation**: every stop belongs to
 * exactly one member, `pool_stops.pool_member_id` is a non-null foreign key, and
 * the server's own rules resolve the same link the same way
 * (`memberById(members, next.poolMemberId)`). Getting it "wrong" would mean picking
 * a stop that is not the next one, which this cannot do — it is handed `nextStop`.
 *
 * It is *not* a lifecycle decision. Nothing here decides whether a pickup is legal;
 * that decision is `allowedActions`, and it arrived already made.
 *
 * If this ever becomes awkward, the fix is a `poolMemberId` on the stop DTO — the
 * project's usual answer when a screen needs a fact the DTO does not carry.
 */
const contextForAction = ({ pool, action }) => {
  const stop = pool.nextStop;
  const actsOnASingleStop =
    action === "ARRIVE_AT_STOP" ||
    action === "PICKUP_PASSENGER" ||
    action === "DROPOFF_PASSENGER";

  if (!actsOnASingleStop) return { poolId: pool.poolId };

  if (!stop) {
    throw new Error(`The server offered ${action} but this pool has no next stop`);
  }

  const member =
    action === "ARRIVE_AT_STOP"
      ? null
      : pool.members.find((candidate) =>
          candidate.stops.some((candidateStop) => candidateStop.stopId === stop.stopId),
        );

  if (action !== "ARRIVE_AT_STOP" && !member) {
    throw new Error(`The server offered ${action} but no member owns the next stop`);
  }

  return {
    poolId: pool.poolId,
    stopId: stop.stopId,
    ...(member ? { memberId: member.poolMemberId } : {}),
  };
};

/**
 * Runs one action from `allowedActions`, resolving the ids it needs.
 *
 * A single entry point so that "which URL does this action use, and what does it
 * need in the path" is answered in one place rather than in the component. The
 * action name is the server's own string; an unknown one is a bug rather than a
 * case to handle, and throws here instead of silently doing nothing.
 *
 * @param {{ pool: import("./types").DriverPool, action: import("./types").TripAction }} command
 * @returns {Promise<import("./types").DriverPool>}
 */
export const runTripAction = ({ pool, action }) => {
  const context = contextForAction({ pool, action });

  switch (action) {
    case "DEPART":
      return departPool(context);
    case "ARRIVE_AT_STOP":
      return arriveAtStop(context);
    case "PICKUP_PASSENGER":
      return pickUpMember(context);
    case "START_TRIP":
      return startTrip(context);
    case "DROPOFF_PASSENGER":
      return dropOffMember(context);
    case "COMPLETE_TRIP":
      return completeTrip(context);
    default:
      throw new Error(`Unknown trip action "${action}"`);
  }
};
