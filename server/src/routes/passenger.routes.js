import { Role } from '@prisma/client';
import { Router } from 'express';

import * as passenger from '../controllers/passenger.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Mounted at /api/passengers.
const router = Router();

/**
 * The passenger's own read APIs.
 *
 * Every route is `requireAuth` + `requireRole(PASSENGER)`, and every path starts
 * with `/me`: there is no `/passengers/:id`, so a client cannot even name another
 * passenger. That is deliberate rather than convenient -- an id in the path is an
 * invitation to try somebody else's, and the answer would have to be a 404 anyway
 * (a 403 would confirm the id exists).
 *
 * These endpoints are read-only. The two passenger write operations -- creating a
 * request and cancelling one -- stay under `/api/ride-requests`, where the state
 * machine that owns them lives, so the history API cannot be used to change a
 * status.
 *
 * `/me/rides` is registered before nothing that could shadow it, but
 * `/me/current-ride` is a sibling literal rather than a sub-path of `/me/rides`,
 * so neither can capture the other.
 */

// The one active ride, or `{ ride: null }`. Never a 404: not riding is normal.
router.get('/me/current-ride', requireAuth, requireRole(Role.PASSENGER), passenger.getCurrentRide);

// The passenger's own history: newest first, filterable by status and date, paged.
router.get('/me/rides', requireAuth, requireRole(Role.PASSENGER), passenger.listMyRides);

// One ride, with its own stops and timeline. Somebody else's is a 404.
router.get('/me/rides/:rideRequestId', requireAuth, requireRole(Role.PASSENGER), passenger.getMyRide);

export default router;
