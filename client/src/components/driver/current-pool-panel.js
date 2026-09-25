"use client";

import { MEMBER_STATUS, POOL_STATUS, STOP_STATUS } from "@/lib/ride-status";
import { TRIP_ACTION } from "@/lib/driver-status";
import { formatDistance, formatDuration, formatTime } from "@/lib/format";
import { Button, Facts, Notice, Panel } from "@/components/ui";
import { Chip, PlaceLine } from "@/components/status-chip";

/**
 * The ride the driver is on, and how to drive it.
 *
 * ---------------------------------------------------------------------------
 * THE BUTTONS ARE THE SERVER'S LIST, NOT THIS COMPONENT'S DECISION
 * ---------------------------------------------------------------------------
 * `allowedActions` arrives with the pool and lists exactly the commands that would
 * succeed right now — computed by the same rules the commands themselves consult,
 * on the same server that will answer them. This panel renders one button per
 * entry, in the order given, and nothing else.
 *
 * So there is no `if (pool.status === "FORMING")` here, and no "is the passenger
 * aboard yet" test. The temptation is real and it is the mistake this whole
 * codebase is arranged to avoid: a client-side lifecycle is a second, weaker copy
 * of the state machine — one with none of the server's tests, that goes wrong the
 * first time a rule changes, and whose failure mode is a button that answers `409`
 * or, worse, a legal action that is never offered because the copy is out of date.
 *
 * Three consequences worth naming:
 *
 *  * **An action that has already succeeded is absent**, not disabled. The server
 *    omits a command whose decision is "repeat", because there is nothing left to
 *    do about it. A greyed-out button here would be inventing history.
 *  * **When the list is empty, nothing is offered**, and the panel says which
 *    situation that is: a finished ride, or a ride waiting on something that is not
 *    the driver's.
 *  * **`nextStop` is where the actions point.** The server publishes it as "the
 *    lowest-sequence stop that is not done: where the driver goes next, and the only
 *    stop they may serve" — and `driver-api.js` resolves the ids from it, so the
 *    button and the request can never disagree about which stop is meant.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DRIVER IS NOT SHOWN
 * ---------------------------------------------------------------------------
 * The fare. `pricing` is a boolean and a version and never an amount: what the
 * passenger pays is between the passenger and the platform, and the server does not
 * put it in this DTO. The panel renders the *fact* that the fare is settled —
 * because a trip cannot start until it is — and nothing more.
 *
 * The passenger's identity is a first name and no more: no profile id, no phone
 * number, nothing to look them up by. That is the server's whitelist, and this
 * panel renders what it is given.
 */
export function CurrentPoolPanel({ pool, busy, error, onAction }) {
  if (!pool) return null;

  const status = POOL_STATUS[pool.status] ?? pool.status;
  const actions = pool.allowedActions ?? [];
  const nextStop = pool.nextStop;

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Your current ride
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {status}
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Accepted {formatTime(pool.acceptedAt)}
            {pool.vehicle ? ` · ${pool.vehicle.name}, ${pool.vehicle.seatCapacity} seats` : ""}
          </p>
        </div>
        <Chip tone={pool.status === "FORMING" ? "waiting" : "active"}>{status}</Chip>
      </div>

      {error ? (
        <Notice tone="error" title="That didn't work" className="mt-4">
          {error.message}
        </Notice>
      ) : null}

      <Facts
        className="mt-4"
        items={[
          { label: "Passengers", value: `${pool.members.length} of ${pool.capacity} seats` },
          { label: "Stops", value: String(pool.plan.stopCount) },
          { label: "Planned distance", value: formatDistance(pool.plan.distanceMeters) },
          { label: "Planned time", value: formatDuration(pool.plan.durationSeconds) },
          {
            label: "Fare settled",
            value: pool.pricing.finalized ? `Yes · v${pool.pricing.poolVersion}` : "Not yet",
          },
          { label: "Set off", value: pool.departedAt ? formatTime(pool.departedAt) : "—" },
        ]}
      />

      {/* ---------------------------------------------------------------- */}
      {/* What the driver may do now                                        */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-5 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
        <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {actions.length > 1 ? "What you can do now" : "What to do next"}
        </p>

        {actions.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            {pool.status === "COMPLETED"
              ? "This ride is finished. There is nothing left to do."
              : "Nothing for you to do at this moment. This screen refreshes itself."}
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {actions.map((action) => (
              <ActionControl
                key={action}
                action={action}
                pool={pool}
                nextStop={nextStop}
                busy={busy}
                onAction={onAction}
              />
            ))}
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The plan, in the order it is driven                               */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-5">
        <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Stops in order
        </p>
        <ol className="mt-2 flex flex-col gap-2">
          {pool.stops.map((stop) => {
            const member = memberAtStop(pool, stop.stopId);
            const isNext = nextStop?.stopId === stop.stopId;

            return (
              <li
                key={stop.stopId}
                className={[
                  "flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2",
                  isNext
                    ? "border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950"
                    : "border-black/[.08] dark:border-white/[.145]",
                ].join(" ")}
              >
                <span className="flex items-baseline gap-2 text-sm">
                  <span className="tabular-nums text-zinc-500">{stop.sequence}.</span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-50">
                    {stop.stopType === "PICKUP" ? "Pick up" : "Drop off"}
                  </span>
                  <span className="text-zinc-600 dark:text-zinc-400">
                    {member?.passenger.displayName ?? "—"}
                  </span>
                  <span className="text-zinc-500">{stop.servicePoint?.name ?? "—"}</span>
                  {isNext ? (
                    <span className="text-xs font-medium text-sky-700 dark:text-sky-300">next</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-3 text-xs text-zinc-500">
                  <span>{STOP_STATUS[stop.status] ?? stop.status}</span>
                  <span className="tabular-nums">
                    {stop.actualArrivalAt
                      ? `arrived ${formatTime(stop.actualArrivalAt)}`
                      : stop.plannedArrivalAt
                        ? `due ${formatTime(stop.plannedArrivalAt)}`
                        : ""}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Who is in the car                                                 */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-5">
        <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Passengers
        </p>
        <div className="mt-2 flex flex-col gap-3">
          {pool.members.map((member) => (
            <div
              key={member.poolMemberId}
              className="rounded-lg border border-black/[.08] p-3 dark:border-white/[.145]"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-medium text-zinc-900 dark:text-zinc-50">
                  {member.passenger.displayName ?? "Passenger"}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-zinc-500">
                    {MEMBER_STATUS[member.status] ?? member.status}
                  </span>
                  <Chip tone="neutral">{member.rideStatus ?? "—"}</Chip>
                </span>
              </div>

              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <PlaceLine label="Pick up" point={member.pickup} />
                <PlaceLine label="Take to" point={member.destination} />
              </div>

              <p className="mt-2 text-xs text-zinc-500">
                {[
                  member.matchedAt ? `matched ${formatTime(member.matchedAt)}` : null,
                  member.pickedUpAt ? `aboard ${formatTime(member.pickedUpAt)}` : null,
                  member.droppedOffAt ? `delivered ${formatTime(member.droppedOffAt)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Not collected yet"}
              </p>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/**
 * One action, as a button that names what it acts on.
 *
 * "Arrive at Banani Road 11", "Pick up Nusrat" — a button that said "Arrive at the
 * next stop" would be asking the driver to work out which stop, two lines above a
 * list that already says so.
 *
 * The names come from the pool, and only the wording comes from `TRIP_ACTION`:
 * whether the action is *offered* was settled before this component ran.
 */
function ActionControl({ action, pool, nextStop, busy, onAction }) {
  const descriptor = TRIP_ACTION[action];

  // An action the server sent that this build does not know how to name. Showing
  // the raw name is better than hiding a command the server says is legal.
  if (!descriptor) {
    return (
      <Button disabled={busy} onClick={() => onAction(action)}>
        {action}
      </Button>
    );
  }

  const member =
    descriptor.target === "member" && nextStop ? memberAtStop(pool, nextStop.stopId) : null;
  const place = descriptor.target === "stop" ? nextStop?.servicePoint?.name : null;
  const person = member?.passenger.displayName;

  const target = place ?? person;
  const label = target ? `${descriptor.label} ${target}` : descriptor.label;

  return (
    <div className="flex flex-col gap-1">
      <Button className="self-start" disabled={busy} onClick={() => onAction(action)}>
        {busy ? "Working…" : label}
      </Button>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{descriptor.help}</p>
    </div>
  );
}

/**
 * The member who owns a stop.
 *
 * A lookup of two published ids, not a derivation: every stop belongs to exactly
 * one member, and `members[].stops[]` carries the same `stopId` the flat `stops`
 * list does. The server resolves the identical link when it decides which commands
 * are legal, so this cannot disagree with it about *who* a stop belongs to.
 */
const memberAtStop = (pool, stopId) =>
  pool.members.find((member) => member.stops.some((stop) => stop.stopId === stopId)) ?? null;
