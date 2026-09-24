import { Role } from '@prisma/client';
import { Router } from 'express';

import * as fare from '../controllers/fare.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Mounted at /api/fare-quotes.
const router = Router();

/**
 * Solo fare quote.
 *
 * Authentication is required, and so is the PASSENGER role: a quote is now a
 * passenger-facing calculation that the passenger *owns*, because a ride request
 * accepts one and ownership is what stops a quote being used by somebody else.
 * `requireAuth` + `requireRole` are the existing guards rather than anything
 * new, and the passenger profile is taken from the authenticated user -- no
 * request field names a passenger.
 *
 * `POST /api/routes/estimate` stays open to any authenticated role: estimating a
 * route is not a commitment and belongs to nobody.
 *
 * The guards are mounted on this route rather than on the router, so an unknown
 * path under /api/fare-quotes still answers 404 rather than 401.
 */
router.post('/', requireAuth, requireRole(Role.PASSENGER), fare.createFareQuote);

export default router;
