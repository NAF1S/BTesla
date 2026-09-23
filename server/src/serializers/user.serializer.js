/**
 * Response DTOs for users and authentication.
 *
 * These are whitelists, not projections of the record: every field is copied
 * out explicitly. A new column -- or `passwordHash`, or an audit timestamp --
 * therefore cannot reach a response by accident.
 */

/**
 * The authenticated user, shaped by role.
 *
 * Only the profile that belongs to the role is included: `passengerProfile` for
 * a PASSENGER, `driverProfile` for a DRIVER, and neither for an ADMIN. Because
 * the key is chosen from the role, a stray profile on the wrong kind of account
 * is never exposed either.
 */
export const toCurrentUserDto = (user) => {
  const dto = {
    id: user.id,
    name: user.name,
    role: user.role,
    active: user.active,
  };

  if (user.role === 'PASSENGER') {
    dto.passengerProfile = user.passengerProfile ? { id: user.passengerProfile.id } : null;
  } else if (user.role === 'DRIVER') {
    dto.driverProfile = user.driverProfile
      ? {
          id: user.driverProfile.id,
          status: user.driverProfile.status,
          vehicles: (user.driverProfile.vehicles ?? []).map((vehicle) => ({
            id: vehicle.id,
            name: vehicle.name,
            seatCapacity: vehicle.seatCapacity,
          })),
        }
      : null;
  }

  return dto;
};
