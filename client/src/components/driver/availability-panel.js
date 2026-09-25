"use client";

import { useState } from "react";

import { DRIVER_AVAILABILITY } from "@/lib/driver-status";
import { Button, Facts, Field, Notice, Panel, Select } from "@/components/ui";
import { Chip } from "@/components/status-chip";

/**
 * Coming online and going offline.
 *
 * ---------------------------------------------------------------------------
 * WHICH CONTROL IS SHOWN IS THE SERVER'S `online` FACT
 * ---------------------------------------------------------------------------
 * `online` is the DTO's own boolean, false exactly when the status is `OFFLINE`.
 * It answers "will dispatch consider me", which is precisely the question that
 * decides whether this screen offers a place to come online at, or a way back out.
 * Reading it is not reimplementing a rule; it is reading a published fact.
 *
 * The two `can…` booleans are used as *guards* rather than as the branch, and they
 * are not opposites:
 *
 *   * `canGoOnline` is true while `OFFLINE` **and** while `AVAILABLE`, so it cannot
 *     decide whether to draw the online form — an available driver shown "Go
 *     online" would be offered a button the write endpoint refuses, because
 *     `AVAILABLE -> AVAILABLE` is not a transition the product implements.
 *   * `canGoOffline` is true only while `AVAILABLE`: a `RESERVED` driver is online
 *     and may still not go offline, because they have accepted a passenger and
 *     releasing that is an operator's decision, not a button's.
 *
 * So nothing here is derived from `status` — which is the mistake to avoid:
 * `disabled={status !== "AVAILABLE"}` would be a second copy of `canGoOffline`,
 * with none of the server's tests.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO "MOVE ME" BUTTON
 * ---------------------------------------------------------------------------
 * The API has one: `PUT /drivers/me/current-service-point`, valid while the driver
 * is offline or available. This screen does not offer it, because the DTO publishes
 * no boolean for "may I move", and working it out from `status` here would be
 * exactly the reimplementation described above. Without it, a driver who wants to
 * relocate goes offline and comes online somewhere else — two clicks, and no new
 * rule. The endpoint is documented for the milestone that adds the boolean.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO SWITCH WHEN THERE IS NO VEHICLE
 * ---------------------------------------------------------------------------
 * A driver needs an active vehicle with capacity to be dispatchable, and **no
 * endpoint in this project creates one**. A driver who signed themselves up
 * therefore has a real account that cannot drive, and the honest screen says so
 * rather than offering a switch that would answer `409` every time.
 */
export function AvailabilityPanel({ availability, servicePoints, busy, error, onSet }) {
  // Local picks, kept apart from the server's answer so that a half-made selection
  // is never mistaken for state. Each falls back to what the server says, which is
  // why nothing here has to be synced back after a write: there is nothing to sync.
  const [pointCode, setPointCode] = useState("");
  const [vehicleId, setVehicleId] = useState("");

  const vehicles = availability.vehicles ?? [];
  const chosenPoint = pointCode || availability.servicePoint?.code || "";

  // What the server would actually use: the vehicle it has selected, or — for a
  // driver with exactly one — that one, because the API reuses it without being
  // asked. Showing "None" beside a driver whose only car is already decided would
  // be true of the field and useless to the reader.
  const vehicle = availability.vehicle ?? (vehicles.length === 1 ? vehicles[0] : null);
  const chosenVehicle = vehicleId || vehicle?.vehicleId || "";

  const status = DRIVER_AVAILABILITY[availability.status] ?? {
    label: availability.status,
    tone: "neutral",
    detail: "",
  };

  // The place list is seeded reference data. An empty list means the seed has not
  // been applied — a different situation from "still loading", and the page read it
  // before rendering, so there is nothing to wait for.
  const noPlaces = servicePoints.length === 0;

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Your availability
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{status.detail}</p>
        </div>
        <Chip tone={status.tone}>{status.label}</Chip>
      </div>

      {error ? (
        <Notice tone="error" title="Could not change your availability" className="mt-4">
          {error.message}
        </Notice>
      ) : null}

      {vehicles.length === 0 ? (
        <Notice tone="warning" title="This account has no vehicle" className="mt-4">
          Dispatch only considers a driver with an active vehicle, and there is no endpoint in this
          project that creates one. Sign in as the seeded driver — the one listed on the status page
          — to be offered a ride.
        </Notice>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          <Facts
            items={[
              {
                label: "Where you are",
                value: availability.servicePoint?.name ?? "Not reported",
              },
              {
                label: "Vehicle",
                value: vehicle ? `${vehicle.name} · ${vehicle.seatCapacity} seats` : "None",
              },
            ]}
          />

          {availability.online && !availability.canGoOffline ? (
            <Notice tone="info">
              You are committed to a ride, so you cannot change your availability from here.
              Finishing it releases you.
            </Notice>
          ) : null}

          {availability.online && availability.canGoOffline ? (
            <Button
              variant="secondary"
              className="self-start"
              disabled={busy}
              onClick={() => onSet({ online: false })}
            >
              {busy ? "Working…" : "Go offline"}
            </Button>
          ) : null}

          {!availability.online && noPlaces ? (
            <Notice tone="warning" title="No service points are available">
              The location seed has not been applied, so there is nowhere to come online at. Run{" "}
              <code className="font-mono">npm run db:seed</code> and reload.
            </Notice>
          ) : null}

          {!availability.online && !noPlaces ? (
            <>
              <Field
                id="driver-point"
                label="Come online at"
                hint="The dispatcher routes from a service point, so this is where it will measure your distance to a pickup from."
              >
                <Select
                  id="driver-point"
                  value={chosenPoint}
                  onChange={(event) => setPointCode(event.target.value)}
                  placeholder="Choose a place"
                  options={servicePoints.map((point) => ({
                    value: point.code,
                    label: `${point.name} · ${point.zoneCode}`,
                  }))}
                />
              </Field>

              {/* A driver with several usable vehicles must say which; one is never
                  picked for them. With one, the server reuses it. */}
              {vehicles.length > 1 ? (
                <Field
                  id="driver-vehicle"
                  label="Vehicle"
                  hint="Dispatch needs to know how many seats are coming with you."
                >
                  <Select
                    id="driver-vehicle"
                    value={chosenVehicle}
                    onChange={(event) => setVehicleId(event.target.value)}
                    placeholder="Choose a vehicle"
                    options={vehicles.map((option) => ({
                      value: option.vehicleId,
                      label: `${option.name} · ${option.seatCapacity} seats`,
                    }))}
                  />
                </Field>
              ) : null}

              <Button
                className="self-start"
                disabled={busy || chosenPoint === "" || chosenVehicle === ""}
                onClick={() =>
                  onSet({ online: true, servicePointCode: chosenPoint, vehicleId: chosenVehicle })
                }
              >
                {busy ? "Working…" : "Go online"}
              </Button>
            </>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
