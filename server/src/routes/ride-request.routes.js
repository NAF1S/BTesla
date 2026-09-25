import { Role } from '@prisma/client';
import { Router } from 'express';

import * as rides from '../controllers/ride-request.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Mounted at /api/ride-requests.
const router = Router();

/**
 * The passenger's own ride requests.
 *
 * Every route is `requireAuth` + `requireRole(PASSENGER)`: a ride request belongs
 * to one passenger, so nothing here is reachable by a driver or an anonymous
 * caller, and no route accepts a passenger identifier. Drivers cannot see
 * unassigned requests in this milestone -- offering work to drivers is matching,
 * and matching is a later milestone.
 *
 * `/my` is registered before `/:id` so the literal path wins; otherwise `:id`
 * would capture it.
 */

// Create. The Idempotency-Key header is required and validated in the controller.
router.post('/', requireAuth, requireRole(Role.PASSENGER), rides.createRideRequest);

// The authenticated passenger's own history.
router.get('/my', requireAuth, requireRole(Role.PASSENGER), rides.listMyRideRequests);

// One request. Somebody else's is a 404, not a 403, so this cannot be used to
// discover which request ids exist.
router.get('/:id', requireAuth, requireRole(Role.PASSENGER), rides.getRideRequest);

// Cancel -- the only passenger-driven status change in this milestone.
router.post('/:id/cancel', requireAuth, requireRole(Role.PASSENGER), rides.cancelRideRequest);

// The caller's own shared fare for this request. Registered after `/:id` because
// it is a sub-path of it, and reachable only by the passenger the request
// belongs to.
router.get('/:id/fare', requireAuth, requireRole(Role.PASSENGER), rides.getRideRequestFare);

export default router;
