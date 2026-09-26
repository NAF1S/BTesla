"use client";

import { useState } from "react";

import { CANCELLATION_REASONS } from "@/lib/ride-status";
import { Button, Field, Notice, Panel, Select } from "@/components/ui";

/**
 * Calling off a ride that nobody has taken yet.
 *
 * ---------------------------------------------------------------------------
 * WHETHER THIS IS OFFERED IS THE SERVER'S ANSWER, NOT A STATUS COMPARISON
 * ---------------------------------------------------------------------------
 * The whole component is rendered only when the ride's `cancellable` flag is true,
 * and that flag *is* the rule: the server computes it with
 * `isCancellable(status)`, which is `status === "WAITING"`. The endpoint enforces
 * the same thing as a state transition — `WAITING -> CANCELLED` is in the machine
 * and `MATCHED -> CANCELLED` is not — so the button and the request cannot
 * disagree.
 *
 * Writing `ride.status === "WAITING"` here instead would be the same answer today
 * and a worse one later. The two versions drift the moment a rule changes: if a
 * matched ride ever becomes cancellable under conditions, this component follows
 * the server automatically, and the hand-written comparison silently stops
 * offering the button. The flag also cannot be *wrong*, because the endpoint that
 * would refuse the call is the one that set it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT TAKES TWO CLICKS
 * ---------------------------------------------------------------------------
 * Cancelling is terminal: `CANCELLED` is a final status, nothing un-cancels it, and
 * the passenger would have to quote and request the journey again. So the control
 * asks twice — and asks *why* in between, because a reason is stored either way and
 * "another reason" as the default is a worse record than a real one.
 *
 * The consequence is stated plainly rather than buried: this is the last moment it
 * can be done. Once a driver accepts, the ride is theirs to drive, and the server
 * stops allowing this.
 */
export function CancelRequest({ busy, error, onCancel }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(CANCELLATION_REASONS[0].value);

  // A conflict is not a failure of the form — it is the ride having moved on while
  // the passenger was deciding. The polite thing is to say so and get out of the
  // way: the tracker's next poll re-renders the screen without this control.
  if (error?.isConflict) {
    return (
      <Notice tone="warning" title="That ride is no longer yours to cancel">
        A driver accepted it a moment ago, so it cannot be called off. Your ride is
        still going ahead — this screen has already updated.
      </Notice>
    );
  }

  return (
    <Panel>
      <h3 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Changed your mind?
      </h3>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        No driver has taken this ride yet, so you can call it off. Any driver we have
        already asked will be told.
      </p>

      {error && !error.isConflict ? (
        <Notice tone="error" title="Could not cancel" className="mt-3">
          {error.message}
        </Notice>
      ) : null}

      {open ? (
        <div className="mt-4 flex flex-col gap-3">
          <Field id="cancel-reason" label="Why are you calling it off?">
            <Select
              id="cancel-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              options={CANCELLATION_REASONS}
            />
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy} onClick={() => onCancel(reason)}>
              {busy ? "Cancelling…" : "Yes, cancel this ride"}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Keep waiting
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Button variant="secondary" className="mt-4" onClick={() => setOpen(true)}>
            Cancel this request
          </Button>
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            This is the last moment you can. Once a driver accepts, the ride is theirs
            to drive and cancelling is no longer offered.
          </p>
        </>
      )}
    </Panel>
  );
}
