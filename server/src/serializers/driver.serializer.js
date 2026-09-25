import { canGoOffline, canGoOnline } from '../services/dispatch.rules.js';

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
 */

const toIsoString = (value) => (value ? new Date(value).toISOString() : null);

export const toDriverAvailabilityDto = (profile) => ({
  driverProfileId: profile.id,
  status: profile.status,
  currentServicePoint: profile.currentServicePoint
    ? { code: profile.currentServicePoint.code, name: profile.currentServicePoint.name }
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
