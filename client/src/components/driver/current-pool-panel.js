"use client";

import { POOL_STATUS, MEMBER_STATUS, STOP_STATUS } from "@/lib/ride-status";
import { TRIP_ACTION } from "@/lib/driver-status";
import { formatDistance, formatDuration, formatTime } from "@/lib/format";
import { Facts, Notice, Panel } from "@/components/ui";
import { Chip, PlaceLine } from "@/components/status-chip";

/**
 * The pool the driver has just committed to.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SUMMARY AND NOT THE CONTROLS
 * ---------------------------------------------------------------------------
 * Accepting a ride is this milestone's endpoint; *driving* it is the next one.
 * This panel therefore shows the plan — who, from where, to where, in what order,
 * and what the server says happens next — and offers no buttons. Offering
 * "Set off" here would mean either wiring five commands that the trip milestone
 * owns, or worse, drawing a button that does nothing.
 *
 * `allowedActions` is still shown, in words. It is the server's own answer to
 * "what happens next", computed by the same rules the trip commands consult, so
 * the driver learns what is expected without the client pretending to be able to
 * do it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DRIVER IS NOT SHOWN
 * ---------------------------------------------------------------------------
 * The fare. `pricing` is a boolean and a version and never an amount: what the
 * passenger pays is between the passenger and the platform, and the server does
 * not put it in this DTO. The screen renders the fact that the fare is settled,
 * because a trip cannot start until it is, and nothing more.
 *
 * The passenger's identity is a first name and no more — no profile id, no phone
 * number, nothing to look them up by. That is the server's whitelist, and this
 * panel simply renders what it is given.
 */
export function CurrentPoolPanel({ pool }) {
  if (!pool) return null;

  const status = POOL_STATUS[pool.status] ?? pool.status;
  const nextAction = pool.allowedActions?.[0];

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

      <Notice tone="info" className="mt-4" title="What happens next">
        {nextAction
          ? TRIP_ACTION[nextAction] ?? nextAction
          : "Nothing left to do on this ride."}{" "}
        The controls for driving it — set off, arrive, collect, start, drop off, finish — are the
        next milestone. This screen shows what the server says is coming.
      </Notice>

      <Facts
        className="mt-4"
        items={[
          { label: "Passengers", value: `${pool.members.length} of ${pool.capacity} seats` },
          { label: "Stops", value: String(pool.plan.stopCount) },
          { label: "Planned distance", value: formatDistance(pool.plan.distanceMeters) },
          { label: "Planned time", value: formatDuration(pool.plan.durationSeconds) },
          { label: "Fare settled", value: pool.pricing.finalized ? `Yes · v${pool.pricing.poolVersion}` : "Not yet" },
        ]}
      />

      {pool.nextStop ? (
        <div className="mt-5">
          <PlaceLine
            label={`Next stop · ${pool.nextStop.stopType === "PICKUP" ? "pick up" : "drop off"}`}
            point={pool.nextStop.servicePoint}
          />
        </div>
      ) : null}

      <div className="mt-5 flex flex-col gap-4">
        {pool.members.map((member) => (
          <div
            key={member.poolMemberId}
            className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]"
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

            <ol className="mt-3 flex flex-col gap-1 text-sm">
              {member.stops.map((stop) => (
                <li key={stop.stopId} className="flex items-center justify-between gap-4">
                  <span className="text-zinc-900 dark:text-zinc-50">
                    <span className="tabular-nums text-zinc-500">{stop.sequence}. </span>
                    {stop.stopType === "PICKUP" ? "Pick up" : "Drop off"}{" "}
                    <span className="text-zinc-500">{stop.servicePoint?.name ?? "—"}</span>
                  </span>
                  <span className="text-xs text-zinc-500">
                    {STOP_STATUS[stop.status] ?? stop.status}
                    {stop.plannedArrivalAt ? ` · ${formatTime(stop.plannedArrivalAt)}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </Panel>
  );
}
