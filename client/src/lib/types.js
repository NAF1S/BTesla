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

/**
 * Why a passenger called a ride off. The closed list the API accepts.
 *
 * A cancellation is only ever permitted from `WAITING`, and `CANCELLED` is
 * terminal — there is no un-cancel. Nothing charges or penalises anybody for it;
 * the reason is a record that the passenger's own history shows back to them.
 *
 * @typedef {"CHANGED_MIND" | "WRONG_LOCATION" | "WAIT_TOO_LONG" | "OTHER"} CancellationReason
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
 * `cancellable` is the server's own answer to "may this be called off?" — true
 * exactly while the request is `WAITING`. Render the cancel control from it rather
 * than from `status`, so the screen cannot disagree with the endpoint that will
 * refuse the call.
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

/**
 * One of the passenger's rides, in full — from `GET /passengers/me/rides/:id`.
 *
 * The same summary a current ride carries, plus the two things a **finished** ride
 * needs and a live one does not: `status` reaches the terminal `COMPLETED` or
 * `CANCELLED` here (the current-ride endpoint stops answering for those), and
 * `timeline` is a list of events rather than a set of instants.
 *
 * `completedAt` is the **request's** own instant, not the pool's. A passenger is
 * delivered while the car may still be carrying somebody else, so the pool's
 * completion would be the wrong moment to show them.
 *
 * @typedef {object} RideDetail
 * @property {string} rideRequestId
 * @property {RideRequestStatus} status
 * @property {boolean} cancellable
 * @property {QuoteEndpoint} pickup
 * @property {QuoteEndpoint} destination
 * @property {string} requestedAt
 * @property {string | null} startedAt
 * @property {string | null} completedAt
 * @property {string | null} cancelledAt
 * @property {{ distanceMeters: number, durationSeconds: number }} route
 * @property {{ fare: string, currency: string, pricingCode: string, pricingVersion: number }} soloEstimate
 * @property {SharedFareSummary | null} sharedFare
 * @property {DriverSummary | null} driver
 * @property {VehicleSummary | null} vehicle
 * @property {number | null} passengerCount
 * @property {PassengerStage} stage
 * @property {PassengerNextAction} nextAction
 * @property {string} searchExpiresAt
 * @property {MemberStatus | null} memberStatus
 * @property {RideStop[]} myStops
 * @property {{ distanceMeters: number, durationSeconds: number } | null} sharedRoute
 * @property {{ poolId: string, status: PoolStatus, passengerCount: number | null, capacity: number, completedAt: string | null } | null} pool
 * @property {{ memberStatus: MemberStatus, matchedAt: string | null, pickedUpAt: string | null, droppedOffAt: string | null } | null} member
 * @property {TimelineEntry[]} timeline
 */

/**
 * One entry in an audience-filtered timeline.
 *
 * The server maps raw events through a whitelist keyed by *event type and
 * audience*, so a passenger never receives a dispatch event and a driver never
 * receives somebody else's ride event. There is no payload and no actor id here:
 * `actorType` says which *kind* of actor acted, never which one.
 *
 * @typedef {object} TimelineEntry
 * @property {number} sequence
 * @property {string} eventType
 * @property {"REQUEST" | "MATCHING" | "PICKUP" | "RIDE" | "END"} phase
 * @property {string} label
 * @property {"PASSENGER" | "DRIVER" | "SYSTEM" | "ADMIN" | null} actorType
 * @property {string} at
 */

// ---------------------------------------------------------------------------
// The driver slice. Everything below is transcribed from
// `server/src/serializers/driver.serializer.js`, `pool.serializer.js` and
// `offer.service.js`'s `toOfferDto`, and is subject to the same rule as
// everything above: the server wins.
// ---------------------------------------------------------------------------

/**
 * A driver's working state. `RESERVED` means they have accepted a ride but not
 * set off; `ON_RIDE` means a trip is under way. Only `AVAILABLE` is dispatchable.
 *
 * @typedef {"OFFLINE" | "AVAILABLE" | "RESERVED" | "ON_RIDE"} DriverAvailabilityStatus
 */

/**
 * The driver's own availability.
 *
 * `online` is the boolean a switch binds to — false exactly when the status is
 * `OFFLINE`. `canGoOnline` / `canGoOffline` are separate derived facts and are
 * what decide whether that switch is usable: a `RESERVED` driver is online and
 * still may not go offline. Never recompute either from `status`.
 *
 * `servicePoint` and `currentServicePoint` are the same place under two names,
 * published so that a client written against either keeps working; only
 * `servicePoint` carries the id.
 *
 * @typedef {object} DriverAvailability
 * @property {string} driverProfileId
 * @property {DriverAvailabilityStatus} status
 * @property {boolean} online
 * @property {DriverAvailabilityStatus} operationalStatus
 * @property {{ code: string, name: string } | null} currentServicePoint
 * @property {{ id: string, code: string, name: string } | null} servicePoint
 * @property {{ vehicleId: string, name: string, seatCapacity: number } | null} vehicle
 * @property {Array<{ vehicleId: string, name: string, seatCapacity: number }>} vehicles
 * @property {string | null} availableSince
 * @property {string | null} lastSeenAt
 * @property {boolean} canGoOnline
 * @property {boolean} canGoOffline
 * @property {string} updatedAt
 */

/** Starting a ride of their own, or joining one they are already driving.
 * @typedef {"INITIAL_RIDE" | "ADD_PASSENGER"} OfferType
 */

/** Only `PENDING` may be answered, and only while `expired` is false.
 * @typedef {"PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "CANCELLED"} OfferStatus
 */

/** The closed list the API accepts when a driver declines a ride.
 * @typedef {"TOO_FAR" | "UNAVAILABLE" | "VEHICLE_ISSUE" | "OTHER"} RejectionReason
 */

/**
 * An offer the driver may answer.
 *
 * One shape, two kinds. An `INITIAL_RIDE` offer has no pool yet, so it carries
 * the two places, the approach and the vehicle. An `ADD_PASSENGER` offer proposes
 * changing a pool the driver is already committed to, so it also carries the plan
 * as it is (`currentStops`) and as it would become (`proposedStops`), plus what
 * the detour costs the people already aboard.
 *
 * `expired` is the server's own answer to "is this still worth answering" — a
 * client that compared `expiresAt` with its own clock would be a second copy of
 * the TTL rule, and would disagree whenever a clock drifted.
 *
 * Never present: the passenger's identity beyond a display name, contact
 * details, the candidate score, or the passenger's fare.
 *
 * @typedef {object} DispatchOffer
 * @property {string} offerId
 * @property {OfferStatus} status
 * @property {OfferType} offerType
 * @property {boolean} expired
 * @property {string} offeredAt
 * @property {string} expiresAt
 * @property {string | null} respondedAt
 * @property {RejectionReason | null} rejectionReason
 * @property {string} rideRequestId
 * @property {{ displayName: string | null } | null} passenger
 * @property {string | null} ridePoolId
 * @property {QuoteEndpoint | null} pickup
 * @property {QuoteEndpoint | null} destination
 * @property {{ distanceMeters: number, durationSeconds: number } | null} passengerRoute
 * @property {{ distanceMeters: number, durationSeconds: number } | null} approach
 * @property {VehicleSummary | null} vehicle
 * @property {number | null} [poolVersion]
 * @property {{ seats: number | null, passengers: number, peakOccupancy: number | null }} [capacity]
 * @property {{ distanceMeters: number | null, durationSeconds: number | null }} [added]
 * @property {number | null} [pickupWaitSeconds]
 * @property {number | null} [pickupEtaSeconds]
 * @property {string | null} [plannedPickupArrivalAt]
 * @property {number | null} [maxExistingPassengerDetourSeconds]
 * @property {Array<{ sequence: number, stopType: string, servicePoint: QuoteEndpoint | null }>} [currentStops]
 * @property {Array<{ sequence: number, stopType: string, servicePoint: QuoteEndpoint | null, isNew: boolean }>} [proposedStops]
 */

/** One of the six commands a driver performs to drive a pool.
 * @typedef {"DEPART" | "ARRIVE_AT_STOP" | "PICKUP_PASSENGER" | "START_TRIP" | "DROPOFF_PASSENGER" | "COMPLETE_TRIP"} TripAction
 */

/** One stop on the driver's plan, in the order it is driven.
 * @typedef {object} DriverPoolStop
 * @property {string} stopId
 * @property {number} sequence
 * @property {"PICKUP" | "DROPOFF"} stopType
 * @property {"PENDING" | "ARRIVED" | "COMPLETED" | "SKIPPED"} status
 * @property {QuoteEndpoint | null} servicePoint
 * @property {string | null} plannedArrivalAt
 * @property {string | null} actualArrivalAt
 * @property {string | null} completedAt
 */

/**
 * One passenger in the driver's pool.
 *
 * `passenger.displayName` is a first name and nothing else — no profile id, no
 * contact details. That is deliberate on the server's side: a driver needs
 * something to greet the rider with, not a way to look them up.
 *
 * @typedef {object} DriverPoolMember
 * @property {string} poolMemberId
 * @property {string} rideRequestId
 * @property {MemberStatus} status
 * @property {RideRequestStatus | null} rideStatus
 * @property {string | null} matchedAt
 * @property {string | null} pickedUpAt
 * @property {string | null} droppedOffAt
 * @property {{ displayName: string | null }} passenger
 * @property {QuoteEndpoint | null} pickup
 * @property {QuoteEndpoint | null} destination
 * @property {DriverPoolStop[]} stops
 */

/**
 * The pool the driver is committed to, as `GET /drivers/me/current-pool` reports
 * it.
 *
 * `allowedActions` lists exactly the trip commands that would succeed right now,
 * computed by the same rules the commands consult. This milestone shows them and
 * does not offer them — the trip execution UI is the next one — so the screen can
 * say what comes next without being able to do it yet.
 *
 * `pricing` is a boolean and a version, never an amount: the passenger's fare is
 * between the passenger and the platform, and showing it to the driver is a
 * product decision this project has not taken.
 *
 * @typedef {object} DriverPool
 * @property {string} poolId
 * @property {PoolStatus} status
 * @property {number} version
 * @property {number} capacity
 * @property {VehicleSummary | null} vehicle
 * @property {{ distanceMeters: number | null, durationSeconds: number | null, stopCount: number }} plan
 * @property {DriverPoolStop[]} stops
 * @property {DriverPoolStop | null} nextStop
 * @property {TripAction[]} allowedActions
 * @property {{ finalized: boolean, finalizedAt: string | null, poolVersion: number | null }} pricing
 * @property {string | null} acceptedAt
 * @property {string | null} departedAt
 * @property {string | null} driverArrivedAt
 * @property {string | null} startedAt
 * @property {string | null} completedAt
 * @property {string | null} cancelledAt
 * @property {DriverPoolMember[]} members
 * @property {Array<{ sequence: number, eventType: string, actorType: string, createdAt: string }>} events
 */

export {};
