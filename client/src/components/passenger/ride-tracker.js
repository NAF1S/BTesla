"use client";

import { useCallback, useEffect, useState } from "react";

import { getCurrentRide } from "@/lib/passenger-api";
import { formatDistance, formatDuration, formatMoney, formatElapsed, formatTime } from "@/lib/format";
import { MEMBER_STATUS, NEXT_ACTION, PASSENGER_STAGE, POOL_STATUS, STOP_STATUS, isFinished } from "@/lib/ride-status";
import { Button, Facts, Heading, LinkButton, Notice, Panel } from "@/components/ui";
import { Chip, Labeled, PlaceLine, RideStatusChip } from "@/components/status-chip";
import { EmptyState, ErrorState, Loading } from "@/components/async-state";

/**
 * The passenger's live view of their ride.
 *
 * ---------------------------------------------------------------------------
 * POLLING, AND WHY IT IS WRITTEN THIS WAY
 * ---------------------------------------------------------------------------
 * There is no push in this project — no WebSockets, no notifications — so the only
 * way to learn that a driver has moved is to ask again. Polling is therefore the
 * honest transport, and the interesting part is doing it without being wasteful or
 * getting it wrong when the component goes away:
 *
 *  * **A recursive `setTimeout`, not `setInterval`.** With an interval, a slow or
 *    hanging request stacks up behind the next tick and the screen can be showing
 *    the answer to a question asked four polls ago. This waits for the reply before
 *    scheduling the next question.
 *  * **It stops when the ride is over.** A finished ride is not polled for: the
 *    endpoint answers with an *active* ride only, so a ride that ends arrives as
 *    `null`, and there is nothing left to learn. That is the "stop polling at
 *    completed or cancelled" requirement, and it is also what makes the final
 *    screen stable rather than flickering.
 *  * **It pauses on a hidden tab.** A passenger who switched away does not need
 *    four requests a minute, and a background tab is a battery. Coming back asks
 *    once, immediately, so the screen is never stale for long.
 *  * **It cancels on unmount.** The `cancelled` flag and the cleared timer are not
 *    decoration: without them a slow reply can call `setState` on an unmounted
 *    component, and a timer outlives the page.
 *  * **A failed poll keeps the last good ride.** The API being briefly unreachable
 *    is not the same as the ride disappearing, and blanking the screen would be a
 *    worse lie than a note saying the last update failed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT SHOWN
 * ---------------------------------------------------------------------------
 * Only this passenger's own facts: their two stops, their fare, the driver's first
 * name and the car. The API cannot return a co-passenger's name, places, fare or
 * events, so there is nothing here to filter out — `passengerCount` is the one
 * shared fact, and it is a number.
 */

/** How often to ask. A few seconds is enough for a stop-based MVP. */
export const POLL_INTERVAL_MS = 5000;

export function RideTracker({ initialRide = null, pollIntervalMs = POLL_INTERVAL_MS }) {
  const [ride, setRide] = useState(initialRide);

  /**
   * The last ride that was actually there.
   *
   * `GET /passengers/me/current-ride` answers with an *active* ride or nothing, so
   * a ride that finishes arrives as `null` — and `ride` alone cannot tell "this
   * passenger never had one" apart from "the one they had is over". Keeping the
   * last non-null ride is what makes that distinction renderable, and it is state
   * rather than a ref because it is read *while rendering*.
   */
  const [lastRide, setLastRide] = useState(initialRide);
  const [error, setError] = useState(null);

  /**
   * The browser's clock, or `null` until this component has run in a browser.
   *
   * "Requested 57 seconds ago" is a fact about *now*, so it cannot be rendered on
   * the server: the server's HTML would say 57 and the browser would hydrate to 58,
   * and React discards the server's markup and rebuilds the tree — a visible
   * flicker, and a warning in the console, on every page load. So the server
   * renders the absolute time instead, the first client render agrees with it, and
   * the relative figure appears once the first poll has established a clock.
   */
  const [now, setNow] = useState(null);

  const load = useCallback(async () => {
    try {
      const current = await getCurrentRide();

      if (current) setLastRide(current);
      setRide(current);
      setError(null);
      setNow(Date.now());

      return current;
    } catch (err) {
      setError(err);
      return undefined;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const scheduleNext = () => {
      timer = setTimeout(tick, pollIntervalMs);
    };

    async function tick() {
      if (cancelled) return;

      // A hidden tab gets one more check and then nothing until it is visible
      // again: the passenger is not looking, so there is nothing to keep current.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        scheduleNext();
        return;
      }

      const current = await load();
      if (cancelled) return;

      // Stop when the ride is gone or finished. `undefined` means the request
      // itself failed, and a failure is not a reason to give up on the ride — the
      // next tick tries again.
      if (current === null || (current && isFinished(current.status))) return;

      scheduleNext();
    }

    // One immediate read, then the cadence. This is what makes a page that was
    // rendered on the server with `initialRide` also self-correcting.
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, pollIntervalMs]);

  /**
   * Re-check as soon as the tab comes back.
   *
   * Without this the screen could sit up to a full interval behind, which is
   * exactly the moment a passenger looks at it.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") load();
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [load]);

  // "The ride ended" is derived, not stored: there was a ride, and now there is
  // not one. A passenger who never had one gets the empty state instead.
  const ended = ride === null && lastRide !== null;

  if (ended) return <RideEnded lastRide={lastRide} />;

  if (error && !ride) {
    return (
      <ErrorState
        title="Could not load your ride"
        message={error.message}
        hint={error.isUnauthenticated ? "Your session may have ended. Sign in again." : null}
        action={
          <Button variant="secondary" onClick={load}>
            Try again
          </Button>
        }
      />
    );
  }

  if (!ride) {
    return (
      <EmptyState
        title="You have no active ride"
        action={
          <LinkButton href="/ride" variant="primary">
            Request a ride
          </LinkButton>
        }
      >
        When you ask for a ride, it will appear here.
      </EmptyState>
    );
  }

  const stage = PASSENGER_STAGE[ride.stage] ?? { label: ride.stage, detail: "" };

  return (
    <div className="flex flex-col gap-5">
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Your ride
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              {stage.label}
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{stage.detail}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <RideStatusChip status={ride.status} />
            {ride.pool ? (
              <Chip>{POOL_STATUS[ride.pool.status] ?? ride.pool.status}</Chip>
            ) : null}
          </div>
        </div>

        <Notice tone="info" className="mt-4">
          {NEXT_ACTION[ride.nextAction] ?? "Waiting for the next update."}
        </Notice>

        <Facts
          className="mt-4"
          items={[
            {
              label: "Requested",
              // Absolute until there is a client clock — see `now` above.
              value:
                now === null
                  ? formatTime(ride.requestedAt)
                  : formatElapsed(ride.requestedAt, { now }),
            },
            {
              label: "Your fare",
              value: ride.sharedFare
                ? formatMoney(ride.sharedFare.fare, ride.sharedFare.currency)
                : formatMoney(ride.soloEstimate.fare, ride.soloEstimate.currency),
            },
            {
              label: "Fare status",
              value: ride.sharedFare
                ? ride.sharedFare.finalized
                  ? "Final"
                  : "Estimate"
                : "Solo estimate",
            },
            { label: "Distance", value: formatDistance(ride.route.distanceMeters) },
            { label: "Estimated time", value: formatDuration(ride.route.durationSeconds) },
            ...(ride.passengerCount && ride.passengerCount > 1
              ? [{ label: "Sharing with", value: `${ride.passengerCount - 1} other passenger(s)` }]
              : []),
          ]}
        />
      </Panel>

      <Panel>
        <Heading level={3}>Your journey</Heading>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <PlaceLine label="Pickup" point={ride.pickup} />
          <PlaceLine label="Destination" point={ride.destination} />
        </div>

        {ride.myStops?.length > 0 ? (
          <ol className="mt-5 flex flex-col gap-2">
            {ride.myStops.map((stop) => (
              <li
                key={stop.stopId}
                className="flex items-center justify-between gap-4 rounded-lg border border-black/[.08] px-3 py-2 dark:border-white/[.145]"
              >
                <span className="text-sm text-zinc-900 dark:text-zinc-50">
                  <span className="font-medium">
                    {stop.stopType === "PICKUP" ? "Pick up" : "Drop off"}
                  </span>{" "}
                  <span className="text-zinc-500">{stop.servicePoint.name}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-zinc-500">{STOP_STATUS[stop.status] ?? stop.status}</span>
                  {stop.actualArrivalAt ? (
                    <span className="text-xs tabular-nums text-zinc-500">
                      {formatTime(stop.actualArrivalAt)}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        {ride.driver || ride.vehicle ? (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {ride.driver ? (
              <Labeled label="Driver">
                <span className="font-medium">{ride.driver.displayName ?? "Assigned"}</span>
              </Labeled>
            ) : null}
            {ride.vehicle ? (
              <Labeled label="Vehicle">
                <span className="font-medium">{ride.vehicle.name}</span>
                <span className="ml-2 text-xs text-zinc-500">
                  {ride.vehicle.seatCapacity} seats
                </span>
              </Labeled>
            ) : null}
          </div>
        ) : null}

        {ride.memberStatus ? (
          <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
            Your status: {MEMBER_STATUS[ride.memberStatus] ?? ride.memberStatus}
          </p>
        ) : null}
      </Panel>

      <Panel>
        <Heading level={3}>What has happened</Heading>
        <Timeline ride={ride} />
        <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
          {error
            ? `Last update failed (${error.message}). Showing the last known state.`
            : `Updated ${now === null ? "—" : formatTime(new Date(now).toISOString())}. Refreshing every ${Math.round(pollIntervalMs / 1000)} seconds.`}
        </p>
      </Panel>
    </div>
  );
}

/**
 * The passenger's own instants, in order.
 *
 * Built from the timestamps the API publishes for *this* passenger — including
 * `driverArrivedAt`, which is their own pickup stop's arrival and not the pool's —
 * so nothing here can describe somebody else's part of the journey.
 */
function Timeline({ ride }) {
  const entries = [
    { label: "Ride requested", at: ride.requestedAt },
    { label: "Driver assigned", at: ride.timeline?.matchedAt },
    { label: "Driver set off", at: ride.timeline?.departedAt },
    { label: "Driver at your pickup", at: ride.timeline?.driverArrivedAt },
    { label: "You were picked up", at: ride.timeline?.pickedUpAt },
    { label: "You were dropped off", at: ride.timeline?.droppedOffAt },
  ].filter((entry) => entry.at);

  if (entries.length === 0) return <Loading label="Waiting for the first update…" />;

  return (
    <ol className="mt-4 flex flex-col gap-3">
      {entries.map((entry) => (
        <li key={entry.label} className="flex items-baseline justify-between gap-4 text-sm">
          <span className="text-zinc-900 dark:text-zinc-50">{entry.label}</span>
          <span className="tabular-nums text-zinc-500">{formatTime(entry.at)}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The screen after the ride stops being active.
 *
 * `GET /passengers/me/current-ride` answers with an *active* ride or nothing, so a
 * ride that ends arrives as `null` and the exact final status — completed, or
 * cancelled — is not in that response. Finding out which needs the ride-detail
 * endpoint, which belongs to a later milestone, so this says what it can show and
 * does not invent the rest.
 */
function RideEnded({ lastRide }) {
  const completed = lastRide?.timeline?.droppedOffAt != null;

  return (
    <Panel className="text-center">
      <Chip tone={completed ? "done" : "stopped"}>
        {completed ? "Ride completed" : "Ride no longer active"}
      </Chip>
      <h2 className="mt-3 text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        {completed ? "You have arrived" : "This ride has finished"}
      </h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {completed
          ? "Thanks for riding with TeslaB."
          : "The ride is no longer active. It may have been completed or cancelled."}
      </p>

      {lastRide ? (
        <Facts
          className="mt-5 text-left"
          items={[
            { label: "From", value: lastRide.pickup.name },
            { label: "To", value: lastRide.destination.name },
            { label: "Requested", value: formatTime(lastRide.requestedAt) },
            lastRide.timeline?.droppedOffAt
              ? { label: "Dropped off", value: formatTime(lastRide.timeline.droppedOffAt) }
              : null,
            lastRide.sharedFare
              ? { label: "Fare", value: formatMoney(lastRide.sharedFare.fare, lastRide.sharedFare.currency) }
              : null,
          ].filter(Boolean)}
        />
      ) : null}

      <div className="mt-5 flex justify-center gap-3">
        <LinkButton href="/ride" variant="primary">
          Request another ride
        </LinkButton>
      </div>
    </Panel>
  );
}
