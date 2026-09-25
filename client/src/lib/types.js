/**
 * The request and response models this client consumes, as JSDoc typedefs.
 *
 * ---------------------------------------------------------------------------
 * WHY HERE, AND NOT TypeScript
 * ---------------------------------------------------------------------------
 * This client is JavaScript (`jsconfig.json`, no `tsc`), so there is no compiler
 * to enforce a type. JSDoc gives the same thing where it matters: an editor
 * understands `@typedef` and `@returns`, so `passenger-api.js` can annotate what
 * each call resolves to and a screen gets autocomplete on the DTO it renders —
 * with no build step and no new dependency.
 *
 * ---------------------------------------------------------------------------
 * THESE ARE COPIES OF THE SERVER'S DTOs, AND THE SERVER WINS
 * ---------------------------------------------------------------------------
 * Every shape here is transcribed from the serializers in `server/src/serializers/`
 * and from `server/openapi.yaml`, which is the machine-readable contract. Nothing
 * here is authoritative: if a field disagrees, the API is right and this file is a
 * bug. The point is to have the shapes written down once, in the place a frontend
 * author looks, rather than being discovered by trial and error.
 *
 * Three conventions the whole API follows, and which the UI depends on:
 *
 *  * **Money is a decimal string**, never a number (`"130.63"`). It is exact, and
 *    it is not for arithmetic — display it, or hand it back unchanged.
 *  * **Instants are UTC ISO-8601 strings**, or `null`. Never an epoch number.
 *  * **A code is a stable machine value** (`banani-road-11`), and the API accepts
 *    it case-insensitively. Send the code, show the name.
 */

/**
 * The authenticated account, as `/auth/me` and the sign-in endpoints report it.
 *
 * A driver's `driverProfile` carries a status and vehicles; a passenger's carries
 * only an id. `role` is read from the database on every request, so it can change
 * under a live session.
 *
 * @typedef {object} SessionUser
 * @property {string} id
 * @property {string} name
 * @property {"PASSENGER" | "DRIVER" | "ADMIN"} role
 * @property {boolean} active
 * @property {{ id: string } | null} [passengerProfile]
 */

/** A service area — a group of service points, for filtering. @typedef {object} Zone
 * @property {string} id
 * @property {string} code
 * @property {string} name
 * @property {number} latitude
 * @property {number} longitude
 */

/**
 * A place a passenger can be collected from or delivered to. The API calls it a
 * service point; the UI calls it a location.
 *
 * @typedef {object} ServicePoint
 * @property {string} id
 * @property {string} code
 * @property {string} name
 * @property {string} zoneCode
 * @property {number} latitude
 * @property {number} longitude
 */

/** The two places a fare is quoted between, as the quote reports them.
 * @typedef {object} QuoteEndpoint
 * @property {string} code
 * @property {string} name
 */

/** The route a quote priced, in both raw and pre-formatted units.
 * @typedef {object} QuoteRoute
 * @property {number} distanceMeters
 * @property {string} distanceKilometers
 * @property {number} durationSeconds
 * @property {string} durationMinutes
 */

/**
 * The priced breakdown of a solo journey.
 *
 * `finalFare` is what the passenger would pay, and it is the **only** number the
 * UI should show as a price. The components are here because the API explains
 * itself, not because a client should add them up — the server already did, with
 * exact decimals, and a client that re-added them in floating point would disagree
 * by a paisa.
 *
 * @typedef {object} QuoteFare
 * @property {string} currency
 * @property {string} pricingCode
 * @property {number} pricingVersion
 * @property {string} baseFare
 * @property {string} distanceFare
 * @property {string} timeFare
 * @property {string} preTrafficSubtotal
 * @property {string} trafficMultiplier
 * @property {string} trafficAdjustment
 * @property {boolean} minimumFareApplied
 * @property {string} finalFare
 */

/**
 * A solo fare estimate. Immutable, owned by the passenger who asked for it, and
 * the thing a ride request is created *from* — a request does not take a pickup
 * and a destination, it takes a quote.
 *
 * @typedef {object} FareQuote
 * @property {string} quoteId
 * @property {QuoteEndpoint} origin
 * @property {QuoteEndpoint} destination
 * @property {string} departureAt
 * @property {string} estimatedArrivalAt
 * @property {"NORMAL" | "RUSH_HOUR"} trafficProfile
 * @property {QuoteRoute} route
 * @property {QuoteFare} fare
 * @property {string} expiresAt
 */

/** `WAITING` -> `MATCHED` -> `IN_PROGRESS` -> `COMPLETED`, or `CANCELLED` / `EXPIRED`.
 * @typedef {"WAITING" | "MATCHED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "EXPIRED"} RideRequestStatus
 */

/** Where the passenger is in their own journey, derived by the server.
 * @typedef {"DRIVER_ASSIGNED" | "DRIVER_EN_ROUTE" | "DRIVER_ARRIVED" | "PICKED_UP" | "IN_PROGRESS" | "RIDE_COMPLETED"} PassengerStage
 */

/** The single thing a passenger's client should offer next, computed by the server.
 * @typedef {"WAIT_FOR_DRIVER" | "WATCH_DRIVER" | "BOARD_VEHICLE" | "IN_RIDE" | "RIDE_FINISHED"} PassengerNextAction
 */

/** The pool's two statuses a passenger is shown. @typedef {"FORMING" | "DRIVER_EN_ROUTE" | "ARRIVED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED"} PoolStatus */

/** This passenger's own member state in the pool. @typedef {"ASSIGNED" | "PICKED_UP" | "DROPPED_OFF" | "CANCELLED" | "NO_SHOW"} MemberStatus */

/** A driver as a passenger may know them: a first name. @typedef {{ displayName: string | null }} DriverSummary */

/** The car that is coming. @typedef {{ name: string, seatCapacity: number }} VehicleSummary */

/**
 * One of the passenger's own two stops. A stop names one member and one type, so
 * a passenger's pickup and drop-off are always two rows — and nobody else's stops
 * are ever in this list.
 *
 * @typedef {object} RideStop
 * @property {string} stopId
 * @property {number} sequence
 * @property {"PICKUP" | "DROPOFF"} stopType
 * @property {"PENDING" | "ARRIVED" | "COMPLETED" | "SKIPPED"} status
 * @property {QuoteEndpoint} servicePoint
 * @property {string | null} plannedArrivalAt
 * @property {string | null} actualArrivalAt
 * @property {string | null} completedAt
 */

/** The passenger's own fare for this ride, once there is one.
 * @typedef {object} SharedFareSummary
 * @property {string} fare
 * @property {string} currency
 * @property {boolean} finalized
 * @property {number | null} poolVersion
 */

/**
 * The passenger's active ride, as `GET /passengers/me/current-ride` reports it.
 *
 * `stage` and `nextAction` are computed on the server from the request's own
 * timestamps. The UI renders them; it never derives them.
 *
 * `passengerCount` is the only fact about the other people in the car, and it is
 * a count — deliberately, because a count cannot be unpacked into a person.
 *
 * @typedef {object} CurrentRide
 * @property {string} rideRequestId
 * @property {RideRequestStatus} status
 * @property {boolean} cancellable
 * @property {QuoteEndpoint} pickup
 * @property {QuoteEndpoint} destination
 * @property {string} requestedAt
 * @property {string | null} startedAt
 * @property {string | null} completedAt
 * @property {string | null} cancelledAt
 * @property {QuoteRoute} route
 * @property {{ fare: string, currency: string, pricingCode: string, pricingVersion: number }} soloEstimate
 * @property {SharedFareSummary | null} sharedFare
 * @property {DriverSummary | null} driver
 * @property {VehicleSummary | null} vehicle
 * @property {number | null} passengerCount
 * @property {PassengerStage} stage
 * @property {PassengerNextAction} nextAction
 * @property {string} searchExpiresAt
 * @property {MemberStatus | null} memberStatus
 * @property {{ poolId: string, status: PoolStatus, completedAt: string | null } | null} pool
 * @property {{ matchedAt: string | null, departedAt: string | null, driverArrivedAt: string | null, pickedUpAt: string | null, droppedOffAt: string | null }} timeline
 * @property {RideStop[]} myStops
 */

/**
 * The ride request a creation returned, in the shape the API publishes.
 *
 * Only the fields this milestone's screens use are listed; the DTO carries more
 * (`acceptedQuote`, `cancellable`, the optional `trip` block).
 *
 * @typedef {object} RideRequestSummary
 * @property {string} id
 * @property {RideRequestStatus} status
 * @property {boolean} cancellable
 * @property {QuoteEndpoint} pickup
 * @property {QuoteEndpoint} destination
 * @property {{ fareQuoteId: string, fare: string, currency: string, pricingCode: string, pricingVersion: number, distanceMeters: number, durationSeconds: number }} acceptedQuote
 * @property {string} requestedAt
 * @property {string} searchExpiresAt
 */

export {};
