import { canGoOffline, canGoOnline, DRIVER_AVAILABILITY } from '../services/dispatch.rules.js';

/**
 * The driver's own availability, as the driver sees it.
 *
 * A whitelist, like every serializer here. What it deliberately never contains:
 * the driver's user id or email (they are in `/auth/me` if a client needs them),
 * the candidate score or any other dispatch internal, and nothing at all about
 * any other driver.
 *
 * `canGoOnline` / `canGoOffline` are derived from the state rather than stored,
 * so a client never has to reimplement the state machine to decide which button
 * to show -- and cannot disagree with the server about it.
 *
 * ---------------------------------------------------------------------------
 * ONLINE, OPERATIONAL STATUS, AND THE TWO NAMES FOR ONE PLACE
 * ---------------------------------------------------------------------------
 * `online` is the boolean a toggle binds to: it is `false` exactly when the
 * driver is OFFLINE, and true for the three states in which the driver is working
 * (`AVAILABLE`, `RESERVED`, `ON_RIDE`). It answers "will dispatch consider me",
 * which is the question a switch is really asking.
 *
 * `operationalStatus` is the same value as `status`, under the name a client that
 * reads the product documentation will look for. It is *read only*: the write
 * endpoint accepts `online` and refuses the word "status" outright, because
 * `RESERVED` and `ON_RIDE` are established by accepting and departing, never by a
 * device claiming them.
 *
 * `servicePoint` carries the same place as `currentServicePoint` plus its `id`,
 * because a client that has to send the point back -- to `PATCH
 * /drivers/me/availability`, say -- wants the identifier. Both names are
 * published: `servicePoint` is the documented one, and `currentServicePoint`
 * stays so that a caller written against the earlier shape keeps working. They
 * are derived from one row in the same function, so they cannot disagree.
 */

const toIsoString = (value) => (value ? new Date(value).toISOString() : null);

const { OFFLINE } = DRIVER_AVAILABILITY;

export const toDriverAvailabilityDto = (profile) => ({
  driverProfileId: profile.id,
  status: profile.status,
  // The same fact twice, under the name each audience knows it by.
  online: profile.status !== OFFLINE,
  operationalStatus: profile.status,
  currentServicePoint: profile.currentServicePoint
    ? { code: profile.currentServicePoint.code, name: profile.currentServicePoint.name }
    : null,
  servicePoint: profile.currentServicePoint
    ? {
        id: profile.currentServicePoint.id,
        code: profile.currentServicePoint.code,
        name: profile.currentServicePoint.name,
      }
    : null,
  vehicle: profile.activeVehicle
    ? {
        vehicleId: profile.activeVehicle.id,
        name: profile.activeVehicle.name,
        seatCapacity: profile.activeVehicle.seatCapacity,
      }
    : null,
  // The driver's own vehicles, so a driver with several knows what to choose
  // from. Only their own, and only the active ones.
  vehicles: (profile.vehicles ?? []).map((vehicle) => ({
    vehicleId: vehicle.id,
    name: vehicle.name,
    seatCapacity: vehicle.seatCapacity,
  })),
  availableSince: toIsoString(profile.availableSince),
  lastSeenAt: toIsoString(profile.lastSeenAt),
  canGoOnline: canGoOnline(profile.status),
  canGoOffline: canGoOffline(profile.status),
  updatedAt: toIsoString(profile.updatedAt),
});
