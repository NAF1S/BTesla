import { Role } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { normalizeEmail, requireEmail, requireName } from '../utils/validation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLES = Object.values(Role);

/** The shape the existing /api/users endpoints have always returned. */
const LEGACY_SELECT = { id: true, name: true, email: true, createdAt: true };

const toLegacyRow = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  created_at: user.createdAt,
});

/**
 * The authenticated-user shape: what the DTO needs, plus `active` so the guard
 * can reject a switched-off account, and the profile belonging to the role.
 */
export const CURRENT_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  passengerProfile: { select: { id: true } },
  driverProfile: {
    select: {
      id: true,
      status: true,
      vehicles: {
        where: { active: true },
        select: { id: true, name: true, seatCapacity: true },
        orderBy: { name: 'asc' },
      },
    },
  },
};

/** Everything authentication needs, including the password hash. */
const AUTHENTICATION_SELECT = {
  id: true,
  name: true,
  role: true,
  active: true,
  passwordHash: true,
  passengerProfile: { select: { id: true } },
  driverProfile: CURRENT_USER_SELECT.driverProfile,
};

export const findAll = async () => {
  const users = await prisma.user.findMany({
    select: LEGACY_SELECT,
    orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
  });
  return users.map(toLegacyRow);
};

export const findById = async (id) => {
  // Avoid a database round-trip (and a cast error) for malformed ids.
  if (!UUID_RE.test(id)) return null;

  const user = await prisma.user.findUnique({ where: { id }, select: LEGACY_SELECT });
  return user ? toLegacyRow(user) : null;
};

/**
 * Looks a user up by login identifier.
 *
 * The lookup uses the normalised value, which is also what is stored, so this
 * can use the UNIQUE index on lower(email) rather than scanning with ILIKE.
 */
export const findByEmail = async (email) => {
  const user = await prisma.user.findUnique({
    where: { email: normalizeEmail(email) },
    select: LEGACY_SELECT,
  });
  return user ? toLegacyRow(user) : null;
};

/** Creates the profile a role requires, or nothing at all for ADMIN. */
const createRoleProfile = async (tx, userId, role) => {
  if (role === Role.PASSENGER) {
    await tx.passengerProfile.create({ data: { userId } });
  } else if (role === Role.DRIVER) {
    await tx.driverProfile.create({ data: { userId } });
  }
};

/**
 * Creates a user together with the profile its role requires, in one
 * transaction.
 *
 * This is what makes "a PASSENGER never exists without a PassengerProfile" a
 * property of the system rather than a hope: either both rows are written or
 * neither is. ADMIN deliberately gets no profile.
 */
export const createWithProfile = async ({ name, email, passwordHash = null, role = Role.PASSENGER }) => {
  if (!ROLES.includes(role)) {
    throw new ApiError(400, `role must be one of ${ROLES.join(', ')}`);
  }

  const normalizedEmail = requireEmail(email);
  const displayName = requireName(name);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name: displayName, email: normalizedEmail, passwordHash, role },
      select: { id: true, role: true },
    });

    await createRoleProfile(tx, user.id, role);

    return user;
  });
};

/** The /api/users create path: a PASSENGER account with its profile. */
export const create = async ({ name, email }) => {
  const { id } = await createWithProfile({ name, email, role: Role.PASSENGER });
  const user = await prisma.user.findUniqueOrThrow({ where: { id }, select: LEGACY_SELECT });
  return toLegacyRow(user);
};

/**
 * Loads a user for a login attempt, including the password hash.
 *
 * The result must never reach a client: serializers/user.serializer.js builds
 * its output as a whitelist precisely so a field like `passwordHash` cannot
 * leak by accident.
 */
export const findForAuthentication = (email) =>
  prisma.user.findUnique({
    where: { email: normalizeEmail(email) },
    select: AUTHENTICATION_SELECT,
  });

/** The authenticated user for a request, or null when it no longer exists. */
export const findCurrentUser = (id) => {
  if (!UUID_RE.test(id)) return null;
  return prisma.user.findUnique({ where: { id }, select: CURRENT_USER_SELECT });
};

/**
 * Records a successful login. Only ever called after the password verified, so
 * a failed attempt never moves `lastLoginAt`.
 */
export const touchLastLogin = (id) =>
  prisma.user.update({
    where: { id },
    data: { lastLoginAt: new Date() },
    select: { id: true },
  });
