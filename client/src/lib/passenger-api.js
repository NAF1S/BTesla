import { apiFetch, apiPost } from "./api";

/**
 * Every backend call a **passenger's** screen makes, in one place.
 *
 * The point of this module is that **a screen never builds a URL**. A component
 * asks for "the zones" or "a quote between these two points" and gets a typed
 * object or an `ApiError`; the paths, the verbs, the body shapes and the header
 * names live here. That is what keeps the frontend thin, and it is what makes the
 * API's conventions visible in one file instead of scattered across pages.
 *
 * Signing in and out is deliberately **not** here -- it belongs to the person, not
 * to the role, and lives in `auth-api.js`. This module is only what a passenger
 * can ask for once they are one.
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
 * `CANCELLED` therefore arrives as `null`, not as a terminal status. This call can
 * see that a ride ended; it cannot say *which* way it ended, and nothing should be
 * inferred from the absence — showing "cancelled" for a completed ride would be a
 * guess about somebody's money.
 *
 * `getRideDetail` is the answer to that question, and the tracker asks it the
 * moment this returns `null` with a ride still in hand.
 *
 * @param {{ cookie?: string }} [options]
 * @returns {Promise<import("./types").CurrentRide | null>}
 */
export const getCurrentRide = async ({ cookie } = {}) => {
  const { ride } = await apiFetch("/passengers/me/current-ride", { cookie });
  return ride ?? null;
};

/**
 * One of the passenger's own rides, in full — **including a finished one**.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WHAT SETTLES THE TERMINAL STATE
 * ---------------------------------------------------------------------------
 * `current-ride` stops answering the moment a ride leaves the active statuses, so
 * the tracker knows a ride ended without knowing how. This endpoint has no status
 * filter: it reads a request that belongs to the passenger whatever state it is in,
 * and reports `status` as the API's own `COMPLETED` or `CANCELLED`.
 *
 * That is the difference between *reporting* and *guessing*. Without it the tracker
 * could only say "this ride is no longer active", and any stronger claim — that the
 * passenger arrived, or that they were cancelled on — would be invented at the one
 * moment somebody cares most about the truth.
 *
 * It also carries what a finished ride needs and a live one does not: the timeline
 * of events as the passenger may see them, the member's own `pickedUpAt`/
 * `droppedOffAt`, and the pool's completion instant. The passenger is delivered
 * while the pool may still be carrying somebody else, so `completedAt` here is the
 * *request's* own instant, not the pool's.
 *
 * A ride that is not this passenger's is a `404`, exactly as an unknown id is.
 *
 * @param {{ rideRequestId: string, cookie?: string }} ride
 * @returns {Promise<import("./types").RideDetail>}
 */
export const getRideDetail = ({ rideRequestId, cookie }) =>
  apiFetch(`/passengers/me/rides/${rideRequestId}`, { cookie });

/**
 * Calls off a request that is still waiting for a driver.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PASSENGER-DRIVEN STATUS CHANGE, AND WHEN IT IS ALLOWED
 * ---------------------------------------------------------------------------
 * The API permits this **only while the request is `WAITING`**, as a transition
 * rather than a special case: `WAITING -> CANCELLED` is in the state machine, and
 * `MATCHED -> CANCELLED` is deliberately not. That is why this takes an id and a
 * reason and nothing else — there is no "force", no override, and no way for a
 * client to talk the server into it.
 *
 * A caller does not need to know the rule, because the server publishes its
 * answer: a ride DTO carries `cancellable`, which is true exactly then. A screen
 * renders the control from that rather than from `status === "WAITING"`, so the
 * two cannot disagree — and if a later milestone makes a matched ride cancellable
 * with conditions, every screen follows without being changed.
 *
 * Cancelling also withdraws any dispatch offer that is outstanding, in the same
 * transaction: a driver who was being asked about this ride is told it is gone
 * rather than left answering a question that no longer has an answer.
 *
 * The failures a caller must handle: `404` if the ride is not theirs (the same
 * answer as an unknown id), and `409` if it stopped being cancellable while the
 * passenger was deciding — which a driver accepting a ride at that exact moment
 * does. A `409` is therefore not an error to retry; it is a re-read.
 *
 * @param {{ rideRequestId: string, reason?: import("./types").CancellationReason }} cancellation
 * @returns {Promise<{ id: string, status: string, cancellationReason: string | null }>}
 */
export const cancelRideRequest = ({ rideRequestId, reason }) =>
  apiPost(`/ride-requests/${rideRequestId}/cancel`, reason ? { reason } : {});
