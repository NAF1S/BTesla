import { Role } from '@prisma/client';

import { ApiError } from '../utils/ApiError.js';
import { readAuthCookie } from '../utils/cookies.js';
import { verifyAuthToken } from '../utils/token.js';
import * as users from '../services/user.service.js';

/** A single message for every unauthenticated outcome, so nothing is revealed. */
const UNAUTHENTICATED = 'Authentication required';

/**
 * Authentication guard.
 *
 * The token is used only to find the user; the user record itself always comes
 * from the database. That is what makes a deactivated account, a deleted
 * account or a changed role take effect on the very next request, regardless of
 * what the token claims -- the token never carries the role.
 *
 * Express 5 forwards rejected promises from middleware to the error handler, so
 * throwing here is equivalent to calling next(err).
 */
export const requireAuth = async (req, _res, next) => {
  const userId = verifyAuthToken(readAuthCookie(req));
  if (!userId) throw new ApiError(401, UNAUTHENTICATED);

  const user = await users.findCurrentUser(userId);
  if (!user || !user.active) throw new ApiError(401, UNAUTHENTICATED);

  req.user = user;
  next();
};

/**
 * Role guard. Must be mounted after requireAuth.
 *
 * The decision is made here, on the server, from the database record -- never
 * from anything the client sent. Front-end route hiding is not authorization.
 */
export const requireRole =
  (...allowedRoles) =>
  (req, _res, next) => {
    if (!req.user) throw new ApiError(401, UNAUTHENTICATED);

    if (!allowedRoles.includes(req.user.role)) {
      throw new ApiError(403, 'You do not have access to this resource');
    }

    next();
  };

/** Convenience accessor for the user attached by requireAuth. */
export const currentUser = (req) => req.user;

/**
 * The authenticated passenger's own PassengerProfile id.
 *
 * This is the only way a request may learn *which* passenger is acting: the
 * value comes from the database record `requireAuth` loaded, never from a body,
 * a query parameter or a token claim. Nothing downstream accepts a passenger id
 * from a client, so there is no parameter to tamper with.
 *
 * A non-passenger, or a passenger without a profile, is refused here even though
 * `requireRole` normally rejects them earlier -- a service must be safe to call
 * directly, not only through one route.
 */
export const requirePassengerProfileId = (user) => {
  if (!user) throw new ApiError(401, UNAUTHENTICATED);
  if (user.role !== Role.PASSENGER) {
    throw new ApiError(403, 'Only a passenger can manage ride requests');
  }

  const passengerProfileId = user.passengerProfile?.id;
  if (!passengerProfileId) {
    throw new ApiError(403, 'A passenger profile is required to request a ride');
  }

  return passengerProfileId;
};
