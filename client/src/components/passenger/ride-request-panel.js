"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createRideRequest, quoteFare } from "@/lib/passenger-api";
import { listServicePoints, listZones } from "@/lib/location-api";
import { formatDistance, formatDuration, formatMoney, formatTime } from "@/lib/format";
import { Button, Facts, Field, Notice, Panel, Select } from "@/components/ui";
import { Chip } from "@/components/status-chip";
import { ErrorState, Loading } from "@/components/async-state";

/**
 * Choosing a journey: where from, where to, what it costs, and requesting it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COMPONENT DECIDES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * It decides *presentation*: which dropdowns are disabled, when to ask for an
 * estimate, what to show while it waits. It decides **no product rule**. The fare
 * is whatever the API returned; the ride request is created from the quote the
 * server issued; and the passenger is never named, because the server derives
 * them from the session.
 *
 * ---------------------------------------------------------------------------
 * WHY IT SUBMITS THE QUOTE IT IS SHOWING
 * ---------------------------------------------------------------------------
 * The tempting shortcut is to call the one-shot `requestRide`, which quotes and
 * requests in one go. This screen does not, and the reason is the price: a quote
 * is priced at an instant by a traffic profile, so quoting again at submit time
 * can return a *different* number from the one on screen. A passenger who agrees
 * to 130.63 and is charged 126.63 has been lucky; the same mechanism can go the
 * other way. So the estimate on screen is the quote that is submitted, and it is
 * re-quoted only when the journey itself changes.
 *
 * The idempotency key is created with that quote and kept until the journey
 * changes, so a retry of the same submission is the same intent — which is what
 * the header means, and what stops a double click creating two rides.
 *
 * ---------------------------------------------------------------------------
 * A NOTE ON THE SHAPE OF THIS COMPONENT
 * ---------------------------------------------------------------------------
 * There is no `quoting` state. Whether an estimate is pending is *derived* —
 * "both ends chosen, and neither a quote nor an error yet" — and the previous
 * answer is discarded by the event that invalidated it, not by an effect. That is
 * not a style preference: an effect that clears state when its own dependencies
 * change is how a screen ends up one render behind, showing a price for the
 * destination the passenger just moved away from.
 */

/** How long to wait after a dropdown changes before asking the API for a price. */
const QUOTE_DEBOUNCE_MS = 350;

/** The two selects have to be told apart for their labels and their ids. */
const ROLE = { ORIGIN: "pickup", DESTINATION: "destination" };

export function RideRequestPanel() {
  const router = useRouter();

  // Locations: loaded once, because they are seeded and stable.
  const [zones, setZones] = useState(null);
  const [points, setPoints] = useState(null);
  const [locationsError, setLocationsError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [zoneCode, setZoneCode] = useState("");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");

  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState(null);

  // Bumped when the current quote can no longer be used and a fresh one is needed
  // even though the journey itself has not changed.
  const [requoteToken, setRequoteToken] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  /**
   * The idempotency key for the quote currently on screen.
   *
   * A ref rather than state: it has to survive re-renders without causing one, and
   * it is only ever read or written in a callback — an event handler or the timer
   * below — never while rendering.
   */
  const idempotencyKey = useRef(null);

  /**
   * Load the two lists.
   *
   * The effect depends on a token rather than calling a `loadLocations` that sets
   * state on its way in: the async body has to reach its first `await` before it
   * touches state at all, and clearing the old answer belongs to the retry button,
   * because that is the event that actually invalidated it.
   */
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const [zoneList, pointList] = await Promise.all([listZones(), listServicePoints()]);
        if (cancelled) return;

        setZones(zoneList);
        setPoints(pointList);
        setLocationsError(null);
      } catch (error) {
        if (!cancelled) setLocationsError(error);
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const reloadLocations = useCallback(() => {
    setZones(null);
    setPoints(null);
    setLocationsError(null);
    setReloadToken((token) => token + 1);
  }, []);

  const zoneNameByCode = useMemo(
    () => new Map((zones ?? []).map((zone) => [zone.code, zone.name])),
    [zones],
  );

  /**
   * The points a dropdown offers, narrowed by the area filter.
   *
   * The point that is already selected is always kept in the list even if the
   * filter would hide it: a `<select>` whose value is not among its options
   * silently renders the first one, which would show the passenger a pickup they
   * did not choose.
   */
  const optionsFor = useCallback(
    (role) => {
      const selected = role === ROLE.ORIGIN ? origin : destination;
      const other = role === ROLE.ORIGIN ? destination : origin;

      return (points ?? [])
        .filter((point) => zoneCode === "" || point.zoneCode === zoneCode || point.code === selected)
        .map((point) => ({
          value: point.code,
          label:
            zoneCode === ""
              ? `${point.name} · ${zoneNameByCode.get(point.zoneCode) ?? point.zoneCode}`
              : point.name,
          // The other end of the journey is disabled rather than validated later,
          // so the impossible choice is not offered. A selected value is never
          // disabled, or the control would be stuck on it.
          disabled: point.code === other && point.code !== selected,
        }));
    },
    [points, zoneCode, origin, destination, zoneNameByCode],
  );

  const bothChosen = origin !== "" && destination !== "" && origin !== destination;

  // Derived, not stored: no quote and no error while both ends are chosen can only
  // mean the request is in flight. See the note at the top of the file.
  const quoting = bothChosen && quote === null && quoteError === null;

  /** Forget the estimate. Only ever called from an event that invalidated it. */
  const clearEstimate = useCallback(() => {
    setQuote(null);
    setQuoteError(null);
    idempotencyKey.current = null;
  }, []);

  /**
   * Asks for a price whenever the journey changes.
   *
   * Debounced, because a passenger moving through the options can fire a change
   * per item, and every one of those is a routing query on the server. The timer is
   * cleared by the next change, so only the journey the passenger settled on is
   * ever priced.
   */
  useEffect(() => {
    if (!bothChosen) return undefined;

    const timer = setTimeout(async () => {
      try {
        const priced = await quoteFare({
          originServicePointCode: origin,
          destinationServicePointCode: destination,
        });

        setQuote(priced);
        setQuoteError(null);
        idempotencyKey.current = newIdempotencyKey(origin, destination);
      } catch (error) {
        setQuoteError(error);
      }
    }, QUOTE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [origin, destination, bothChosen, requoteToken]);

  /**
   * Changing the area clears both ends.
   *
   * Because the chosen points may not be in the new area, and silently keeping a
   * pickup that is no longer in the list is how a passenger ends up requesting a
   * ride from somewhere they did not pick.
   */
  const onZoneChange = (event) => {
    setZoneCode(event.target.value);
    setOrigin("");
    setDestination("");
    setSubmitError(null);
    clearEstimate();
  };

  const onEndpointChange = (role) => (event) => {
    const value = event.target.value;
    const nextOrigin = role === ROLE.ORIGIN ? value : origin;
    const nextDestination = role === ROLE.DESTINATION ? value : destination;

    setOrigin(nextOrigin);
    setDestination(nextDestination);
    setSubmitError(null);
    clearEstimate();
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    if (!quote || !idempotencyKey.current || submitting) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      await createRideRequest({
        fareQuoteId: quote.quoteId,
        idempotencyKey: idempotencyKey.current,
      });

      // The ride exists now. Tracking is a different screen, and it reads the ride
      // from the API rather than being handed it — so a refresh works there.
      router.push("/track");
    } catch (error) {
      setSubmitError(error);

      // A quote that expired or was already spent cannot be retried, so it is
      // discarded and a fresh one asked for — letting the passenger try again with
      // the price they will actually be charged.
      if (error.isNotFound || error.isConflict) {
        clearEstimate();
        setRequoteToken((token) => token + 1);
      }

      setSubmitting(false);
    }
  };

  const locationsLoading = zones === null && points === null && !locationsError;

  return (
    <div className="flex flex-col gap-5">
      <Panel>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Where are you going?
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Pick two different points. You will see the price before anything is booked.
            </p>
          </div>

          {locationsError ? (
            <ErrorState
              title="Could not load locations"
              message={locationsError.message}
              hint={
                locationsError.network
                  ? "Start the API with npm run dev."
                  : "The seeded service points may be missing. Run npm run db:seed."
              }
              action={
                <Button variant="secondary" onClick={reloadLocations}>
                  Try again
                </Button>
              }
            />
          ) : null}

          {locationsLoading ? <Loading label="Loading service areas…" /> : null}

          {points !== null && points.length === 0 ? (
            <Notice tone="warning" title="No service points are available">
              The location seed has not been applied. Run{" "}
              <code className="font-mono">npm run db:seed</code> and reload.
            </Notice>
          ) : null}

          {points !== null && points.length > 0 ? (
            <>
              <Field
                id="zone"
                label="Service area"
                hint="Narrows the two lists below. Changing it clears your choices."
              >
                <Select
                  id="zone"
                  value={zoneCode}
                  onChange={onZoneChange}
                  options={[
                    { value: "", label: "All areas" },
                    ...(zones ?? []).map((zone) => ({ value: zone.code, label: zone.name })),
                  ]}
                />
              </Field>

              <Field id="pickup" label="Pickup point">
                <Select
                  id="pickup"
                  value={origin}
                  onChange={onEndpointChange(ROLE.ORIGIN)}
                  placeholder="Choose a pickup point"
                  options={optionsFor(ROLE.ORIGIN)}
                />
              </Field>

              <Field
                id="destination"
                label="Destination"
                error={
                  origin === "" || destination === "" || origin !== destination
                    ? null
                    : "Your pickup and destination are the same point. Choose a different one."
                }
              >
                <Select
                  id="destination"
                  value={destination}
                  onChange={onEndpointChange(ROLE.DESTINATION)}
                  placeholder="Choose a destination"
                  options={optionsFor(ROLE.DESTINATION)}
                />
              </Field>
            </>
          ) : null}

          <EstimateBlock
            quoting={quoting}
            quote={quote}
            error={quoteError}
            bothChosen={bothChosen}
          />

          {submitError ? (
            <Notice
              tone="error"
              title={
                submitError.isConflict ? "Could not book this ride" : "Could not request the ride"
              }
            >
              {submitError.message}
              {submitError.isConflict ? (
                <p className="mt-1">
                  You may already be on a ride. Check the tracking screen before trying again.
                </p>
              ) : null}
            </Notice>
          ) : null}

          <Button type="submit" disabled={!quote || submitting} className="self-start">
            {submitting ? "Requesting…" : "Request this ride"}
          </Button>
        </form>
      </Panel>
    </div>
  );
}

/** The price panel: a spinner, the estimate, or why there is none. */
function EstimateBlock({ quoting, quote, error, bothChosen }) {
  if (!bothChosen) {
    return (
      <Notice tone="info">
        Choose a pickup point and a destination to see the estimated fare.
      </Notice>
    );
  }

  if (quoting) return <Loading label="Getting an estimate…" />;

  if (error) {
    return (
      <ErrorState
        title="No estimate for this journey"
        message={error.message}
        hint={error.status === 422 ? "There may be no route between these two points." : null}
      />
    );
  }

  if (!quote) return null;

  return (
    <div className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Estimated fare
          </p>
          {/* Straight from the API, as a decimal string. Nothing is computed here. */}
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            {formatMoney(quote.fare.finalFare, quote.fare.currency)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Chip tone={quote.trafficProfile === "RUSH_HOUR" ? "waiting" : "neutral"}>
            {quote.trafficProfile === "RUSH_HOUR" ? "Rush hour" : "Normal traffic"}
          </Chip>
          {quote.fare.minimumFareApplied ? <Chip>Minimum fare</Chip> : null}
        </div>
      </div>

      <Facts
        className="mt-4"
        items={[
          { label: "Distance", value: formatDistance(quote.route.distanceMeters) },
          { label: "Estimated time", value: formatDuration(quote.route.durationSeconds) },
          { label: "From", value: quote.origin.name },
          { label: "To", value: quote.destination.name },
          { label: "Estimate valid until", value: formatTime(quote.expiresAt) },
        ]}
      />
    </div>
  );
}

/**
 * A key for one journey, unique per attempt at requesting it.
 *
 * Kept beside the quote rather than regenerated per click, so a retry is the same
 * intent. The server requires 8–128 characters, and a UUID satisfies that.
 */
const newIdempotencyKey = (origin, destination) =>
  `ride-${origin}-${destination}-${crypto.randomUUID()}`.slice(0, 128);
