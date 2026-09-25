"use client";

import { useState } from "react";

import { OFFER_STATUS, OFFER_TYPE, REJECTION_REASONS } from "@/lib/driver-status";
import { formatDistance, formatDuration, formatTime } from "@/lib/format";
import { Button, Facts, Field, Notice, Panel, Select } from "@/components/ui";
import { Chip, Labeled, PlaceLine } from "@/components/status-chip";

/**
 * One ride the driver is being asked to take.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DRIVER IS BEING ASKED, EXACTLY
 * ---------------------------------------------------------------------------
 * An `INITIAL_RIDE` offer proposes a ride that does not exist yet: two places and
 * the passenger's route. An `ADD_PASSENGER` offer proposes changing a pool the
 * driver is *already* driving, and shows the plan as it is against the plan it
 * would become — that comparison is the decision, so it is not flattened into the
 * same sentence as a new ride.
 *
 * The two numbers that matter most here are the approach (`how far do I have to
 * drive before I earn anything`) and the passenger's journey. Both come from the
 * server's router; neither is estimated here.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT SHOW
 * ---------------------------------------------------------------------------
 * The passenger's fare. Money is between the passenger and the platform, and the
 * server does not publish it on an offer — a driver who is shown what the rider
 * pays is being invited to negotiate, which is a product this is not. It also does
 * not show the candidate score, which the server keeps for explaining the choice
 * afterwards and never returns.
 *
 * ---------------------------------------------------------------------------
 * WHETHER IT MAY BE ANSWERED IS THE SERVER'S ANSWER
 * ---------------------------------------------------------------------------
 * `expired` comes from the offer, computed against the server's own clock. A
 * client that compared `expiresAt` with its own would be a second copy of the TTL
 * rule and would disagree whenever a clock drifted — and the buttons would be
 * live on an offer the server is about to refuse.
 */
export function OfferCard({ offer, busy, onAccept, onReject }) {
  const [reason, setReason] = useState("TOO_FAR");
  const [confirming, setConfirming] = useState(false);

  const status = OFFER_STATUS[offer.status] ?? { label: offer.status, tone: "neutral" };
  const actionable = offer.status === "PENDING" && !offer.expired;

  return (
    <Panel as="li" className="list-none">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {OFFER_TYPE[offer.offerType] ?? offer.offerType}
          </p>
          <h3 className="mt-1 text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {offer.passenger?.displayName
              ? `Ride for ${offer.passenger.displayName}`
              : "A ride to start"}
          </h3>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Chip tone={offer.expired ? "stopped" : status.tone}>
            {offer.expired ? "Expired" : status.label}
          </Chip>
          {actionable ? (
            <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              Answer before {formatTime(offer.expiresAt)}
            </span>
          ) : null}
        </div>
      </div>

      {offer.offerType === "INITIAL_RIDE" ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <PlaceLine label="Pick them up at" point={offer.pickup} />
          <PlaceLine label="Take them to" point={offer.destination} />
        </div>
      ) : null}

      <Facts
        className="mt-4"
        items={[
          {
            label: "Your drive to them",
            value: offer.approach
              ? `${formatDistance(offer.approach.distanceMeters)} · ${formatDuration(offer.approach.durationSeconds)}`
              : "You are there",
          },
          {
            label: "Their journey",
            value: offer.passengerRoute
              ? `${formatDistance(offer.passengerRoute.distanceMeters)} · ${formatDuration(offer.passengerRoute.durationSeconds)}`
              : "—",
          },
          // Only present on a join offer, and the whole point of one.
          ...(offer.added
            ? [
                {
                  label: "Extra driving",
                  value: `${formatDistance(offer.added.distanceMeters)} · ${formatDuration(offer.added.durationSeconds)}`,
                },
              ]
            : []),
          ...(offer.maxExistingPassengerDetourSeconds !== undefined &&
          offer.maxExistingPassengerDetourSeconds !== null
            ? [
                {
                  label: "Longest delay to a passenger aboard",
                  value: formatDuration(offer.maxExistingPassengerDetourSeconds),
                },
              ]
            : []),
          {
            label: "Vehicle",
            value: offer.vehicle ? `${offer.vehicle.name} · ${offer.vehicle.seatCapacity} seats` : "—",
          },
        ]}
      />

      {offer.offerType === "ADD_PASSENGER" && offer.proposedStops?.length > 0 ? (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <Labeled label="Your plan now">
              <PlanList stops={offer.currentStops} />
            </Labeled>
          </div>
          <div>
            <Labeled label="If you accept">
              <PlanList stops={offer.proposedStops} />
            </Labeled>
          </div>
        </div>
      ) : null}

      {actionable ? (
        <div className="mt-5 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy} onClick={() => onAccept(offer.offerId)}>
              {busy ? "Working…" : "Accept"}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirming((open) => !open)}
            >
              {confirming ? "Keep considering" : "Decline…"}
            </Button>
          </div>

          {confirming ? (
            <div className="flex flex-col gap-3 rounded-lg border border-black/[.08] p-3 dark:border-white/[.145]">
              <Field
                id={`reason-${offer.offerId}`}
                label="Why are you declining?"
                hint="Dispatch remembers a refusal, and it counts towards how the next ride is offered. The passenger keeps waiting and the ride goes to the next driver."
              >
                <Select
                  id={`reason-${offer.offerId}`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  options={REJECTION_REASONS}
                />
              </Field>
              <Button
                variant="secondary"
                className="self-start"
                disabled={busy}
                onClick={() => onReject(offer.offerId, reason)}
              >
                {busy ? "Working…" : "Decline this ride"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <Notice tone="info" className="mt-5">
          {offer.expired
            ? "This offer ran out before it was answered. The ride has been passed to another driver."
            : "This offer is closed. Its record stays here as part of your history."}
        </Notice>
      )}
    </Panel>
  );
}

/** The stop order, as a numbered list. A plan is a list; a paragraph would hide it. */
function PlanList({ stops = [] }) {
  return (
    <ol className="mt-1 flex flex-col gap-1 text-sm">
      {stops.map((stop) => (
        <li key={`${stop.sequence}-${stop.servicePoint?.code ?? stop.sequence}`} className="flex gap-2">
          <span className="tabular-nums text-zinc-500">{stop.sequence}.</span>
          <span className="text-zinc-900 dark:text-zinc-50">
            {stop.stopType === "PICKUP" ? "Pick up" : "Drop off"}
            {stop.isNew ? <span className="ml-1 text-xs text-sky-600 dark:text-sky-400">new</span> : null}
          </span>
          <span className="text-zinc-500">{stop.servicePoint?.name ?? "—"}</span>
        </li>
      ))}
    </ol>
  );
}
