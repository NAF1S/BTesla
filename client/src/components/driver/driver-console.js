"use client";

import { useCallback, useRef, useState } from "react";

import {
  acceptOffer,
  getAvailability,
  getCurrentPool,
  listOffers,
  rejectOffer,
  setAvailability,
} from "@/lib/driver-api";
import { usePolling } from "@/lib/use-polling";
import { formatTime } from "@/lib/format";
import { Heading, Notice } from "@/components/ui";
import { EmptyState, ErrorState } from "@/components/async-state";
import { AvailabilityPanel } from "./availability-panel";
import { CurrentPoolPanel } from "./current-pool-panel";
import { OfferCard } from "./offer-card";

/**
 * The driver's console: am I online, what am I being offered, what am I driving.
 *
 * ---------------------------------------------------------------------------
 * THIS SCREEN POLLS, AND THE POLL IS ALSO A HEARTBEAT
 * ---------------------------------------------------------------------------
 * There is no push in this project, so a driver learns about a ride by asking.
 * The API makes that asking do double duty: `lastSeenAt` is refreshed when a
 * driver goes online, moves, **reads their offers**, or answers one. A location
 * older than the freshness window (300 s by default) makes them ineligible,
 * because a location that cannot be trusted is not one the server can promise a
 * passenger.
 *
 * So this screen polls while — and only while — the driver is online. That is not
 * a trick to keep a demo working: reading the offers is the only signal this
 * project has that a driver is still at the wheel, and it is exactly why a driver
 * who goes online and never opens the screen stops being offered rides.
 *
 * The asking is skipped in a hidden tab, resumed the moment the tab is looked at,
 * and cancelled on unmount. `usePolling` is where all of that lives, because the
 * passenger's tracker needs the same rules.
 *
 * ---------------------------------------------------------------------------
 * THE FIRST PAINT COMES FROM THE SERVER
 * ---------------------------------------------------------------------------
 * `initial` is what the driver's page read while rendering, so the console
 * arrives with real state on it instead of a spinner. The first poll then corrects
 * it, which is what makes a page rendered a moment ago self-sufficient.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not decide when a button is available: `canGoOnline`, `canGoOffline`
 * and an offer's `expired` flag come from the server. It does not decide what
 * acceptance means: it posts an offer id and *no body*, and renders the pool that
 * comes back. And it does not offer the six trip commands — those belong to the
 * next milestone, and the pool summary shows what the server says comes next.
 */
export function DriverConsole({ initial }) {
  const [availability, setAvailabilityState] = useState(initial.availability);
  const [offers, setOffers] = useState(initial.offers);
  const [pool, setPool] = useState(initial.pool);

  /** A failure of the polling loop: "we are flying blind", not "your click failed". */
  const [pollError, setPollError] = useState(null);

  /**
   * A failure of something the driver did, **with the section that caused it**.
   *
   * The scope is not decoration. Every action here moves the same three values, so
   * without it a refused offer would be reported under "Could not change your
   * availability" — a sentence that names the wrong thing and sends the driver
   * looking in the wrong place.
   */
  const [actionError, setActionError] = useState(null);

  /** A one-line confirmation, e.g. that a declined ride went to somebody else. */
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  /**
   * The three reads this screen lives on.
   *
   * All three are read every tick, even though an available driver has no pool and
   * their status only rarely changes. The alternative is for the client to work
   * out *when* each one can differ, and "only a committed driver has a pool" is a
   * product rule this client does not get to hold. Three small reads are cheaper
   * than a second copy of a rule — and the offers read is the heartbeat, so it was
   * happening anyway.
   *
   * ---------------------------------------------------------------------------
   * WHY THESE ARE SEQUENTIAL AND NOT `Promise.all`
   * ---------------------------------------------------------------------------
   * Three parallel requests are provably unreliable here, and the failure is
   * silent rather than obvious: the dev server's `/api` rewrite intermittently
   * resets one of the three connections (`read ECONNRESET`) while the API itself
   * answers `200` to every one of them. The browser sees a `500` from a healthy
   * API, and the console reports a refresh failure that never happened.
   *
   * One at a time costs three round trips of a few milliseconds each — nothing on
   * a poll that runs every five seconds — and it has a second, quieter benefit:
   * the three answers are read in order rather than simultaneously, so there is a
   * smaller window in which they can describe three different moments.
   *
   * ---------------------------------------------------------------------------
   * AND WHY REFRESHES ARE QUEUED RATHER THAN SIMPLY STARTED
   * ---------------------------------------------------------------------------
   * Sequential reads on their own were not enough. The poll and an action can both
   * decide to refresh at the same moment — you decline an offer, and the poll comes
   * round while the decline is in flight — and two refresh *chains* overlap even
   * though neither chain is parallel. That reproduced the same reset.
   *
   * So refreshes are queued: each caller waits for the previous one and then runs
   * its own. Returning the in-flight promise instead would be cheaper and wrong,
   * because an action needs the state its own write produced, not the state a poll
   * happened to be reading when the write started.
   */
  const refreshQueue = useRef(Promise.resolve());

  const refresh = useCallback(() => {
    const next = refreshQueue.current.then(async () => {
      const nextAvailability = await getAvailability();
      const nextOffers = await listOffers({ status: "PENDING" });
      const nextPool = await getCurrentPool();

      setAvailabilityState(nextAvailability);
      setOffers(nextOffers);
      setPool(nextPool);
    });

    // The queue must survive a failed read: one bad refresh cannot be allowed to
    // wedge every later one behind a rejected promise.
    refreshQueue.current = next.catch(() => {});

    return next;
  }, []);

  const tick = useCallback(async () => {
    try {
      await refresh();
      setPollError(null);
    } catch (error) {
      // A failed poll keeps what is on screen and says so. Blanking the ride
      // because the API hiccuped would be worse than a slightly stale line.
      setPollError(error);
    }

    // Keep asking. There is no terminal state here: even a driver in the middle
    // of a ride is waiting to hear whether another passenger is being added.
    return true;
  }, [refresh]);

  /**
   * The cadence, and the one screen-level decision this file makes about polling.
   *
   * While the console is **on screen** it asks every five seconds, so an offer
   * appears while the driver is looking at it — offers expire after thirty
   * seconds, so anything much slower would routinely show them one that had
   * already gone.
   *
   * In a **background tab** it keeps asking, at thirty seconds. That is not a
   * compromise for battery: reading the offers is the heartbeat, a location older
   * than five minutes drops the driver out of dispatch, and a driver with the
   * screen in the background is still driving. Thirty seconds stays comfortably
   * inside that window while asking six times less often. (The passenger's tracker
   * does the opposite — it *stops* in a hidden tab — because a ride nobody is
   * looking at has nothing to keep current.)
   */
  usePolling(tick, {
    enabled: availability.online,
    intervalMs: 5000,
    backgroundIntervalMs: 30000,
  });

  /**
   * Runs one driver action, reports its failure **where it belongs**, and re-reads
   * what it changed.
   *
   * Every action here changes more than it returns. Going online changes who is
   * eligible; accepting changes the pool, the driver's own status *and* which
   * offers are still open. So each one re-reads afterwards instead of patching the
   * local copy — the server is the only thing that knows the whole answer.
   */
  const run = useCallback(
    async (work, { after, scope } = {}) => {
      setBusy(true);
      setActionError(null);
      setNotice(null);

      try {
        const result = await work();
        await after?.(result);
      } catch (error) {
        setActionError({ scope, error });

        // Re-read even on failure. The usual failure here is "the state moved on
        // while you were looking" — an offer that expired, a ride somebody else
        // took — and the honest screen is the fresh one.
        try {
          await refresh();
        } catch {
          // The poll error above will report it on the next tick.
        }
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const onSetAvailability = (change) =>
    run(() => setAvailability(change), {
      scope: "availability",
      // Newly online means newly offered: do not make them wait an interval.
      // `refresh` also re-reads the availability itself.
      after: refresh,
    });

  const onAccept = (offerId) =>
    run(() => acceptOffer({ offerId }), {
      scope: "offers",
      after: async (acceptedPool) => {
        // The acceptance response *is* the pool, so it is shown immediately; the
        // refresh then brings the driver's new status (RESERVED) with it.
        setPool(acceptedPool);
        await refresh();
        setNotice("Ride accepted. The passenger sees a driver assigned.");
      },
    });

  const onReject = (offerId, reason) =>
    run(() => rejectOffer({ offerId, reason }), {
      scope: "offers",
      after: async () => {
        await refresh();
        setNotice("Ride declined. It was passed on to the next driver.");
      },
    });

  return (
    <div className="flex flex-col gap-6">
      <AvailabilityPanel
        availability={availability}
        servicePoints={initial.servicePoints}
        busy={busy}
        error={actionError?.scope === "availability" ? actionError.error : null}
        onSet={onSetAvailability}
      />

      {pollError ? (
        <ErrorState
          title="Could not refresh"
          message={pollError.message}
          hint="Showing the last state that was read. This screen keeps trying."
        />
      ) : null}

      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {pool ? <CurrentPoolPanel pool={pool} /> : null}

      <section className="flex flex-col gap-4">
        <Heading level={2} description="An offer goes to one driver at a time, and it expires.">
          Offers
        </Heading>

        {actionError?.scope === "offers" ? (
          <Notice tone="error" title="Could not answer that offer">
            {actionError.error.message}
          </Notice>
        ) : null}

        {offers.length === 0 ? (
          <EmptyState title="No ride offers right now">
            {/* Three situations, and the difference matters: a driver committed to
                a ride is not in the dispatch pool for new ones, but can still be
                asked to take an extra passenger into the car they are driving.
                Saying "you are in the dispatch pool" to them would be wrong. */}
            {!availability.online
              ? "You are offline, so dispatch is not considering you. Come online to be offered rides."
              : availability.canGoOffline
                ? "You are in the dispatch pool. An offer arrives when a passenger near you asks for a ride — and only one driver is asked at a time."
                : "You are on a ride, so dispatch will not start you on another one. Another passenger can still be added to the car you are driving, and that offer would appear here."}
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-4">
            {offers.map((offer) => (
              <OfferCard
                key={offer.offerId}
                offer={offer}
                busy={busy}
                onAccept={onAccept}
                onReject={onReject}
              />
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {availability.online
          ? "Refreshing every 5 seconds while you are online — reading your offers is also how the server knows you are still there. A driver it has not heard from in five minutes stops being offered rides."
          : "Offline: nothing is being asked of the server, and dispatch is not considering you."}
        {availability.lastSeenAt ? ` Last seen ${formatTime(availability.lastSeenAt)}.` : ""}
      </p>
    </div>
  );
}
