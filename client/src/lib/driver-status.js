/**
 * Names for the driver-side states the **server** decided.
 *
 * ---------------------------------------------------------------------------
 * THE SAME RULE AS `ride-status.js`, APPLIED TO THE OTHER HALF
 * ---------------------------------------------------------------------------
 * This module contains no rules. The API publishes a driver's `status` and the
 * two booleans `canGoOnline` / `canGoOffline`; it publishes an offer's `status`,
 * `offerType` and its own `expired` flag; it publishes a pool's `allowedActions`.
 * Every one of those is computed on the server from the same rules the write
 * endpoints consult. This file only *renames* them for a screen.
 *
 * The mistake to avoid is deciding any of it here:
 *
 *     const canGoOffline = status === "AVAILABLE";        // NO
 *     const expired = new Date(offer.expiresAt) < now;    // NO
 *     const canDepart = pool.status === "FORMING";        // NO
 *
 * Each of those is a second, weaker copy of a rule that already exists — with
 * none of the server's tests, and one that will disagree with it the first time a
 * rule changes. The server publishes `canGoOffline`, `expired` and
 * `allowedActions` precisely so that a client does not have to work them out. If a
 * screen needs a fact that is not in the DTO, the fix is a field in the DTO.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE FROM `ride-status.js`
 * ---------------------------------------------------------------------------
 * Not for bundling — they are both tiny — but because the two vocabularies are
 * read by different people working on different screens. A passenger screen has
 * no business importing a driver's availability states, and a driver screen does
 * not need the passenger's stages. Two files, each with one audience, and only the
 * pool/stop names shared, because those genuinely are the same words on both
 * sides (they come from `ride-status.js`).
 */

/** The chip tone for a state. `neutral` is "nothing to do here". */
const TONE = {
  waiting: "waiting",
  active: "active",
  done: "done",
  stopped: "stopped",
  neutral: "neutral",
};

/**
 * The driver's own working state.
 *
 * `canGoOnline` / `canGoOffline` are the two that matter to a screen, and they
 * are separate facts rather than opposites: a `RESERVED` driver is online and yet
 * may not go offline, because they have already accepted a passenger. The label
 * and tone here are decoration on top of the status; the *behaviour* always comes
 * from the booleans.
 *
 * @type {Record<import("./types").DriverAvailabilityStatus, { label: string, tone: string, detail: string }>}
 */
export const DRIVER_AVAILABILITY = {
  OFFLINE: {
    label: "Offline",
    tone: "stopped",
    detail: "Dispatch is not considering you. You may come online at any service point.",
  },
  AVAILABLE: {
    label: "Available",
    tone: "active",
    detail: "You are in the dispatch pool and may be offered a ride.",
  },
  RESERVED: {
    label: "On a ride",
    tone: "waiting",
    detail:
      "You have accepted a ride and are committed to it. Only finishing it frees you — going offline is an operator's decision, not a button here.",
  },
  ON_RIDE: {
    label: "Driving",
    tone: "waiting",
    detail: "A trip is under way. You are released when you complete it.",
  },
};

/**
 * The two kinds of offer, in words.
 *
 * `ADD_PASSENGER` is a *join* offer: it proposes changing a pool the driver is
 * already committed to, and accepting one adds a passenger to a car they are
 * already driving rather than starting a new ride. That distinction is the whole
 * point of the type, so a screen must not flatten the two into "a ride offer".
 *
 * @type {Record<import("./types").OfferType, string>}
 */
export const OFFER_TYPE = {
  INITIAL_RIDE: "New ride",
  ADD_PASSENGER: "Add a passenger",
};

/**
 * An offer's status.
 *
 * Only `PENDING` is actionable, and even then only while `expired` is false —
 * which the server tells us rather than us comparing timestamps. The rest are
 * history: the offers a driver has already answered, or that ran out while they
 * were looking.
 *
 * @type {Record<import("./types").OfferStatus, { label: string, tone: string }>}
 */
export const OFFER_STATUS = {
  PENDING: { label: "Waiting for your answer", tone: TONE.waiting },
  ACCEPTED: { label: "Accepted", tone: TONE.done },
  REJECTED: { label: "Declined", tone: TONE.stopped },
  EXPIRED: { label: "Expired", tone: TONE.stopped },
  CANCELLED: { label: "Withdrawn", tone: TONE.stopped },
};

/**
 * The four reasons the product defines for refusing a ride.
 *
 * This list is closed and it is the API's: the value goes into the record and
 * into the driver's own dispatch score, so a reason made up here would be a `400`
 * and a wrong history. `OTHER` is the server's default when a refusal says
 * nothing, and it is deliberately not offered as a first choice.
 *
 * @type {Array<{ value: import("./types").RejectionReason, label: string }>}
 */
export const REJECTION_REASONS = [
  { value: "TOO_FAR", label: "Too far away" },
  { value: "UNAVAILABLE", label: "Not available right now" },
  { value: "VEHICLE_ISSUE", label: "Problem with the vehicle" },
  { value: "OTHER", label: "Another reason" },
];

/**
 * What each of the six trip commands is called, and what it acts on.
 *
 * ---------------------------------------------------------------------------
 * WHY `target` IS HERE, AND WHY IT IS NOT A RULE
 * ---------------------------------------------------------------------------
 * `allowedActions` names an action but is not *addressable*: it says
 * `PICKUP_PASSENGER`, not which passenger. The pool publishes the other half —
 * `nextStop`, and each member's own stops — so `target` says what the button has to
 * name in order to be understandable: "Pick up **Nusrat**" rather than "Pick up the
 * passenger".
 *
 * That is presentation. It does not say whether the action is *allowed* — the
 * server decided that before the action name arrived — and it does not choose the
 * stop: `driver-api.js` resolves both from `nextStop`. A screen that read `target`
 * as permission would be doing the server's job.
 *
 * @type {Record<import("./types").TripAction, { label: string, done: string, target: "none" | "stop" | "member", help: string }>}
 */
export const TRIP_ACTION = {
  DEPART: {
    label: "Set off",
    done: "You have set off",
    target: "none",
    help: "Closes the ride to further passengers, freezes the fare, and puts you on the way to the first pickup.",
  },
  ARRIVE_AT_STOP: {
    label: "Arrive at",
    done: "Arrival recorded",
    target: "stop",
    help: "Tells the passenger you are there. A later stop cannot be reached before this one.",
  },
  PICKUP_PASSENGER: {
    label: "Pick up",
    done: "Passenger collected",
    target: "member",
    help: "Marks the passenger as aboard. At a shared corner the stop stays open until everybody there has been collected.",
  },
  START_TRIP: {
    label: "Start the trip",
    done: "The trip has started",
    target: "none",
    help: "Begins the journey proper. A passenger still to be collected further along keeps waiting to be picked up during it.",
  },
  DROPOFF_PASSENGER: {
    label: "Drop off",
    done: "Passenger delivered",
    target: "member",
    help: "Completes this passenger's ride. The pool keeps running for anybody else in the car.",
  },
  COMPLETE_TRIP: {
    label: "Complete the trip",
    done: "Trip completed — you are free again",
    target: "none",
    help: "Finishes the ride and releases you. Refused while any stop is unfinished or anybody is still in the car.",
  },
};
