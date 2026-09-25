import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { requireDriverProfileId } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import {
  canGoOffline,
  canGoOnline,
  canSetCurrentServicePoint,
  DRIVER_AVAILABILITY,
  IMPLEMENTED_AVAILABILITY_TRANSITIONS,
} from './dispatch.rules.js';

/**
 * Driver availability: the one authoritative source of whether a driver can be
 * offered a ride, and where they are.
 *
 * WHY THIS IS A LOCKED TRANSACTION
 *
 * Going online and going offline are state changes a dispatcher reads while
 * choosing candidates, so they are written under a row lock and validated
 * against the state read *inside* the transaction. A driver cannot be dispatched
 * on stale availability, and two concurrent requests cannot leave the profile in
 * a state that contradicts itself (for example AVAILABLE with no service point,
 * which `driver_profiles_available_has_location` also refuses).
 *
 * WHY THE RELATIONS ARE READ AFTER THE COMMIT
 *
 * Prisma resolves nested relations with several statements at once. Inside an
 * interactive transaction that means issuing concurrent queries on one
 * connection, which the PostgreSQL driver reports as deprecated (and will refuse
 * in pg@9). So a transaction reads scalars only, and the response is assembled
 * from a post-commit read of the row it just wrote -- the same pattern the ride
 * request service uses.
 */

/** Everything the availability decision needs. Scalars only, by design. */
const DRIVER_SCALARS = {
  id: true,
  userId: true,
  status: true,
  currentServicePointId: true,
  availableSince: true,
  lastSeenAt: true,
  activeVehicleId: true,
  createdAt: true,
  updatedAt: true,
};

/** The relations the driver's own availability DTO needs. Post-commit only. */
const DRIVER_INCLUDE = {
  currentServicePoint: { select: { code: true, name: true } },
  activeVehicle: { select: { id: true, name: true, seatCapacity: true } },
  vehicles: {
    where: { active: true },
    select: { id: true, name: true, seatCapacity: true },
    orderBy: { name: 'asc' },
  },
};

const inTransaction = (work) =>
  prisma.$transaction(work, { timeout: env.dispatch.transactionTimeoutMs });

/** Reads a committed driver profile in the shape the DTO needs. */
export const loadDriverForDto = (driverProfileId) =>
  prisma.driverProfile.findUnique({ where: { id: driverProfileId }, include: DRIVER_INCLUDE });

export const resolveDriverProfileId = (user) => requireDriverProfileId(user);

/** Re-exported so a service can be safe to call directly, not only through a route. */
export { requireDriverProfileId };

/** Locks one driver profile for the rest of the transaction. */
const lockDriver = async (tx, driverProfileId) => {
  await tx.$queryRawUnsafe(
    `SELECT id FROM driver_profiles WHERE id = $1::uuid FOR UPDATE`,
    driverProfileId,
  );
  return tx.driverProfile.findUnique({ where: { id: driverProfileId }, select: DRIVER_SCALARS });
};

/**
 * The same lock, for the code that only needs to hold the row still.
 *
 * Acceptance takes it before it decides, so a driver cannot be dispatched a
 * second ride in the instant between "is this driver still AVAILABLE?" and
 * "reserve them".
 */
export const lockDriverProfile = async (tx, driverProfileId) => {
  await tx.$queryRawUnsafe(
    `SELECT id FROM driver_profiles WHERE id = $1::uuid FOR UPDATE`,
    driverProfileId,
  );
};

const notFound = (driverProfileId) =>
  new ApiError(404, `Driver profile "${driverProfileId}" was not found`);

/**
 * The service point a driver reports themselves at.
 *
 * A point that does not exist and a point that is switched off are different
 * answers on purpose: one is a typo, the other is a place that cannot be
 * driven to, and the driver can act on each differently.
 */
const resolveServicePoint = async (tx, code) => {
  const point = await tx.servicePoint.findUnique({
    where: { code },
    select: { id: true, code: true, name: true, active: true },
  });

  if (!point) throw new ApiError(404, `Service point "${code}" was not found`);
  if (!point.active) {
    throw new ApiError(409, `Service point "${code}" is not accepting rides right now`);
  }

  return point;
};

/**
 * The vehicle a driver goes online with.
 *
 * The rule the brief asks for, in order: an explicitly chosen vehicle wins; a
 * driver who went online before is put back in the same one; a driver with
 * exactly one usable vehicle does not have to choose; and a driver with several
 * *must* choose rather than have one picked for them. An inactive or zero-capacity
 * vehicle is never selected -- not even as a fallback.
 */
const resolveVehicle = async (tx, { driverProfileId, vehicleId, preferredVehicleId }) => {
  const vehicles = await tx.vehicle.findMany({
    where: { driverId: driverProfileId },
    select: { id: true, name: true, seatCapacity: true, active: true },
    orderBy: { name: 'asc' },
  });

  const usable = vehicles.filter((vehicle) => vehicle.active && vehicle.seatCapacity > 0);

  if (vehicleId) {
    const chosen = vehicles.find((vehicle) => vehicle.id === vehicleId);
    if (!chosen) {
      throw new ApiError(404, `Vehicle "${vehicleId}" was not found for this driver`);
    }
    if (!chosen.active) {
      throw new ApiError(409, `Vehicle "${chosen.name}" is not active`);
    }
    if (chosen.seatCapacity <= 0) {
      throw new ApiError(409, `Vehicle "${chosen.name}" has no capacity`);
    }
    return chosen;
  }

  const remembered = usable.find((vehicle) => vehicle.id === preferredVehicleId);
  if (remembered) return remembered;

  if (usable.length === 0) {
    throw new ApiError(
      409,
      vehicles.length === 0
        ? 'A driver needs a vehicle before going online'
        : 'A driver needs an active vehicle with capacity before going online',
    );
  }

  if (usable.length > 1) {
    throw new ApiError(
      409,
      'This driver has more than one active vehicle; choose which one to go online with',
    );
  }

  return usable[0];
};

/**
 * Goes online: AVAILABLE, at a service point, with a vehicle.
 *
 * All four preconditions are checked here *and* on the row the dispatcher will
 * read: an active driver profile, an active vehicle with positive capacity, an
 * active service point, and a state that may become available.
 */
export const goOnline = async ({
  driver,
  currentServicePointCode,
  vehicleId = null,
  now = new Date(),
}) => {
  const driverProfileId = resolveDriverProfileId(driver);

  await inTransaction(async (tx) => {
    const profile = await lockDriver(tx, driverProfileId);
    if (!profile) throw notFound(driverProfileId);

    if (!canGoOnline(profile.status)) {
      throw new ApiError(
        409,
        `A driver who is ${profile.status} cannot go online; the ride they accepted has to finish or be released first`,
      );
    }

    const point = await resolveServicePoint(tx, currentServicePointCode);
    const vehicle = await resolveVehicle(tx, {
      driverProfileId,
      vehicleId,
      preferredVehicleId: profile.activeVehicleId,
    });

    await tx.driverProfile.update({
      where: { id: driverProfileId },
      data: {
        status: DRIVER_AVAILABILITY.AVAILABLE,
        currentServicePointId: point.id,
        // Re-reporting while already available does not reset the clock, so a
        // driver cannot lose (or gain) idle credit by refreshing their position.
        availableSince: profile.status === DRIVER_AVAILABILITY.AVAILABLE && profile.availableSince
          ? profile.availableSince
          : now,
        lastSeenAt: now,
        activeVehicleId: vehicle.id,
      },
    });
  });

  return loadDriverForDto(driverProfileId);
};

/**
 * Goes offline.
 *
 * Idempotent on purpose: a retried "go offline" that already succeeded is not an
 * error, and answering 409 to a retry is how clients end up stuck. A RESERVED or
 * ON_RIDE driver is refused instead -- they are committed to a passenger, and
 * releasing that is a decision an operator makes, not a device.
 */
export const goOffline = async ({ driver, now = new Date() }) => {
  const driverProfileId = resolveDriverProfileId(driver);

  await inTransaction(async (tx) => {
    const profile = await lockDriver(tx, driverProfileId);
    if (!profile) throw notFound(driverProfileId);

    if (profile.status === DRIVER_AVAILABILITY.OFFLINE) return;

    if (!canGoOffline(profile.status)) {
      throw new ApiError(
        409,
        `A driver who is ${profile.status} cannot go offline through this endpoint`,
      );
    }

    await tx.driverProfile.update({
      where: { id: driverProfileId },
      data: {
        status: DRIVER_AVAILABILITY.OFFLINE,
        availableSince: null,
        lastSeenAt: now,
        // The vehicle is remembered: it is the one they will come back online
        // with, and it is not a claim about where they are.
      },
    });
  });

  return loadDriverForDto(driverProfileId);
};

/**
 * Reports the driver at a service point.
 *
 * This is the MVP's stand-in for GPS: the driver says which seeded point they are
 * nearest. It is also how a driver refreshes `last_seen_at` while waiting for an
 * offer, which is what keeps them eligible -- a driver who has not reported in
 * for `DISPATCH_LOCATION_FRESHNESS_SECONDS` is skipped, because a location we
 * cannot trust is not a location we can promise a passenger.
 *
 * A RESERVED or ON_RIDE driver cannot move: they are already on their way to a
 * pickup, and the pool they belong to is planned from the point they accepted at.
 */
export const setCurrentServicePoint = async ({
  driver,
  currentServicePointCode,
  now = new Date(),
}) => {
  const driverProfileId = resolveDriverProfileId(driver);

  await inTransaction(async (tx) => {
    const profile = await lockDriver(tx, driverProfileId);
    if (!profile) throw notFound(driverProfileId);

    if (!canSetCurrentServicePoint(profile.status)) {
      throw new ApiError(
        409,
        `A driver who is ${profile.status} cannot change their current service point`,
      );
    }

    const point = await resolveServicePoint(tx, currentServicePointCode);

    await tx.driverProfile.update({
      where: { id: driverProfileId },
      data: { currentServicePointId: point.id, lastSeenAt: now },
    });
  });

  return loadDriverForDto(driverProfileId);
};

/** The driver's own availability, as the API reports it. */
export const getAvailability = async ({ driver }) => {
  const driverProfileId = resolveDriverProfileId(driver);

  const profile = await loadDriverForDto(driverProfileId);
  if (!profile) throw notFound(driverProfileId);

  return profile;
};

/**
 * Records that the driver was seen, without changing what they are doing.
 *
 * Called when a driver reads their offers or answers one: those are exactly the
 * moments we learn they are still there. It is a plain update rather than a
 * locked one because nothing depends on the previous value.
 */
export const touchLastSeen = async (driverProfileId, now = new Date()) =>
  prisma.driverProfile.update({
    where: { id: driverProfileId },
    data: { lastSeenAt: now },
    select: { id: true },
  });

/**
 * Whether a driver's reported location is fresh enough to be dispatched on.
 * Exported so the dispatcher and the tests share one definition of "stale".
 */
export const isLocationFresh = ({ lastSeenAt, now, freshnessSeconds }) => {
  if (!lastSeenAt) return false;
  const age = new Date(now).getTime() - new Date(lastSeenAt).getTime();
  return age <= freshnessSeconds * 1000;
};

/** True when this milestone can perform the transition, for tests and callers. */
export const isImplementedChange = (from, to) => {
  const allowed = IMPLEMENTED_AVAILABILITY_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
};
