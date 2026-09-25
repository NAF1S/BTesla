"use client";

import { useEffect, useRef } from "react";

/**
 * Asking the API the same question over and over, correctly.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A HOOK AND NOT TWO SIMILAR EFFECTS
 * ---------------------------------------------------------------------------
 * There is no push in this project — no WebSockets, no notifications — so polling
 * is the transport, and both live screens need it: the passenger watches a ride,
 * the driver watches for an offer. The *policy* is what has to be identical, and
 * every part of it is load-bearing:
 *
 *  * **A recursive `setTimeout`, not `setInterval`.** With an interval, a slow or
 *    hanging request stacks up behind the next tick and the screen ends up showing
 *    the answer to a question asked four polls ago. This waits for the reply
 *    before scheduling the next question.
 *  * **A hidden tab is skipped** — unless the caller gives it a
 *    `backgroundIntervalMs`, in which case it keeps asking, just less often. Which
 *    of the two is right depends on *why* the screen polls, and the two screens
 *    disagree:
 *      - the **passenger's tracker** is only useful to somebody looking at it, so
 *        it stops in a hidden tab and resumes the moment the tab is looked at;
 *      - the **driver's console** is also a heartbeat. Reading the offers is the
 *        only signal this project has that a driver is still at the wheel, and a
 *        location older than five minutes drops them out of dispatch. A driver
 *        with the screen in the background is still driving, so that tab must
 *        keep proving it is there.
 *  * **Becoming visible asks immediately.** Otherwise the screen is up to a full
 *    interval stale at exactly the moment somebody looks at it.
 *  * **It stops when the caller says so.** `tick` returning `false` ends the loop
 *    for good: there is nothing left to learn. The passenger's ride ending is that
 *    case.
 *  * **Unmount cancels everything.** The flag and the cleared timer are not
 *    decoration: without them a slow reply calls `setState` on a component that is
 *    gone.
 *  * **One request in flight at a time.** Resuming from a hidden tab while a tick
 *    is still running would otherwise overlap two reads, and the older answer could
 *    land last.
 *
 * Writing that six times over two components is how the two drift apart — one gets
 * the visibility fix, the other gets the in-flight guard — so it is written once.
 * A component supplies the question, how often to ask it, and whether to keep
 * asking; this decides when.
 *
 * @param {() => Promise<boolean>} tick The question. Return `false` to stop polling.
 * @param {{ intervalMs?: number, backgroundIntervalMs?: number, enabled?: boolean }} [options]
 */
export function usePolling(tick, { intervalMs = 5000, backgroundIntervalMs, enabled = true } = {}) {
  /**
   * The current `tick`, kept in a ref so that a caller who rebuilds the function
   * every render does not restart the loop — and so that the loop always calls the
   * newest one. Reading a ref during render is not allowed; writing it in an effect
   * is exactly what it is for.
   */
  const tickRef = useRef(tick);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    let inFlight = false;
    let timer = null;

    const hidden = () =>
      typeof document !== "undefined" && document.visibilityState === "hidden";

    /**
     * How long to wait before the next question.
     *
     * A hidden tab with a background interval asks *less often*, not never — and a
     * hidden tab without one asks never, which is signalled by not scheduling at
     * all.
     */
    const schedule = () => {
      const hiddenNow = hidden();
      if (hiddenNow && backgroundIntervalMs === undefined) return;

      timer = setTimeout(run, hiddenNow ? backgroundIntervalMs : intervalMs);
    };

    async function run() {
      if (cancelled || inFlight) return;

      inFlight = true;
      try {
        const keepGoing = await tickRef.current();
        if (cancelled) return;

        if (keepGoing === false) return;
        schedule();
      } finally {
        inFlight = false;
      }
    }

    const onVisible = () => {
      if (!hidden()) run();
    };

    // One immediate read, then the cadence — unless the tab starts hidden and this
    // screen has no business asking in the background.
    if (!(hidden() && backgroundIntervalMs === undefined)) run();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, intervalMs, backgroundIntervalMs]);
}
