/**
 * Names for the states the **server** decided.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND EMPHATICALLY IS NOT
 * ---------------------------------------------------------------------------
 * This module contains no rules. The server publishes a ride request's `status`, a
 * passenger's `stage` and the single `nextAction` the client should offer, and
 * every one of them is computed there from the ride's own timestamps. This file
 * only *renames* those values for a screen: `DRIVER_EN_ROUTE` becomes "Driver on
 * the way", with a colour.
 *
 * The distinction matters, because the tempting mistake is to write
 * `if (status === "MATCHED" && !departedAt)` somewhere in a component. That is a
 * second, weaker copy of the state machine — one that will disagree with the
 * server the first time a rule changes, and that has none of the server's tests.
 * If a screen needs to know something about a ride that is not in the DTO, the fix
 * is a field in the DTO, not a computation here.
 *
 * `POLLING_STOP_STATUSES` is the one place this module makes a decision, and it is
 * a decision about *traffic*, not about the ride: when the passenger's ride is
 * over there is nothing left to poll for. It never affects which button is
 * rendered.
 */

/** The chip tone for a state. `neutral` is for "nothing to do yet". */
const TONE = {
  waiting: "waiting",
  active: "active",
  done: "done",
  stopped: "stopped",
};

/**
 * The request's own status, in words.
 *
 * @type {Record<import("./types").RideRequestStatus, { label: string, tone: string }>}
 */
export const REQUEST_STATUS = {
  WAITING: { label: "Finding a driver", tone: TONE.waiting },
  MATCHED: { label: "Driver assigned", tone: TONE.active },
  IN_PROGRESS: { label: "On the way", tone: TONE.active },
  COMPLETED: { label: "Completed", tone: TONE.done },
  CANCELLED: { label: "Cancelled", tone: TONE.stopped },
  EXPIRED: { label: "No driver found", tone: TONE.stopped },
};

/**
 * Where the passenger is in their own journey, in words.
 *
 * `stage` is the finer of the two values the API publishes, and it is the one a
 * tracker should headline: "Your driver has arrived" is more use than "Matched".
 *
 * @type {Record<import("./types").PassengerStage, { label: string, detail: string }>}
 */
export const PASSENGER_STAGE = {
  // `DRIVER_ASSIGNED` is the server's *pre-departure* stage, not "a driver
  // accepted": it is what `passengerTripStage` returns when the driver has not set
  // off yet, which covers both `WAITING` (nobody found) and `MATCHED` (found, still
  // parked). The request's own status is what tells those two apart, and the chip
  // above the headline renders it. So this copy deliberately claims neither.
  DRIVER_ASSIGNED: {
    label: "Waiting for a driver",
    detail:
      "Your driver has not set off yet. The status above says whether one has been assigned.",
  },
  DRIVER_EN_ROUTE: {
    label: "Driver on the way",
    detail: "Your driver has set off and is heading to your pickup point.",
  },
  DRIVER_ARRIVED: {
    label: "Driver has arrived",
    detail: "Your driver is at your pickup point. Look for the car.",
  },
  PICKED_UP: {
    label: "You are in the car",
    detail: "You have been picked up. The trip starts once your driver sets off.",
  },
  IN_PROGRESS: {
    label: "Trip in progress",
    detail: "You are on your way to your destination.",
  },
  RIDE_COMPLETED: {
    label: "Ride completed",
    detail: "You have been dropped off. Thanks for riding.",
  },
};

/**
 * The one thing the passenger may do next, as the server sees it.
 *
 * Rendered as guidance rather than as a button, because this milestone has no
 * passenger action to offer: there is no cancellation yet, and everything else is
 * the driver's to do. A client that invented a button here would be inventing a
 * rule.
 *
 * `WAIT_FOR_DRIVER` is deliberately vague about *why* the passenger is waiting,
 * and that is not laziness. The server returns it for the whole pre-departure
 * stretch — `WAITING` (nobody found yet) and `MATCHED` (found, still parked) alike
 * — because "there is nothing for you to do" is the true answer in both. Saying
 * "we are looking for a driver" would be wrong the moment one has been assigned,
 * and the assigned case is the common one. The status chip sits inches away and
 * says which it is; this line only says that waiting is correct.
 *
 * @type {Record<import("./types").PassengerNextAction, string>}
 */
export const NEXT_ACTION = {
  WAIT_FOR_DRIVER: "Nothing to do just yet — this screen updates on its own.",
  WATCH_DRIVER: "Watch for your driver to arrive at your pickup point.",
  BOARD_VEHICLE: "Your car is here — get in when it is safe to.",
  IN_RIDE: "Sit back — your driver is taking you to your destination.",
  RIDE_FINISHED: "This ride is finished. You can request another.",
};

/**
 * The pool's status, which says what the *car* is doing.
 *
 * Shown beside the passenger stage when a passenger is matched, because "the car
 * you are in has started moving" and "your part of the journey has started" are
 * not the same sentence.
 *
 * @type {Record<string, string>}
 */
export const POOL_STATUS = {
  FORMING: "Being put together",
  DRIVER_EN_ROUTE: "Driver on the way",
  ARRIVED: "Driver at a pickup",
  IN_PROGRESS: "Trip in progress",
  COMPLETED: "Trip completed",
  CANCELLED: "Trip cancelled",
};

/**
 * The passenger's own member state.
 *
 * @type {Record<string, string>}
 */
export const MEMBER_STATUS = {
  ASSIGNED: "Waiting to be collected",
  PICKED_UP: "In the car",
  DROPPED_OFF: "Dropped off",
  CANCELLED: "Cancelled",
  NO_SHOW: "Not collected",
};

/** A stop's status, for the two-stop list. @type {Record<string, string>} */
export const STOP_STATUS = {
  PENDING: "Not reached yet",
  ARRIVED: "Reached",
  COMPLETED: "Done",
  SKIPPED: "Skipped",
};

/**
 * The statuses that mean there is nothing left to poll for.
 *
 * The `current-ride` endpoint answers with an *active* ride only, so a finished
 * ride arrives as `null` rather than as a `COMPLETED` status — this list is the
 * defence for the moment a ride is read as it ends. Either way the tracker stops.
 */
export const POLLING_STOP_STATUSES = ["COMPLETED", "CANCELLED", "EXPIRED"];

/** Whether a ride is over, for the purpose of stopping the poll. @param {string} status */
export const isFinished = (status) => POLLING_STOP_STATUSES.includes(status);
