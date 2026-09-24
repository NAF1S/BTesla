import { Router } from 'express';

import * as fare from '../controllers/fare.controller.js';
import { requireAuth } from '../middleware/auth.js';

// Mounted at /api/fare-quotes.
const router = Router();

/**
 * Solo fare quote.
 *
 * Authentication is required, matching `POST /api/routes/estimate`: a quote is
 * served to a known account, and `requireAuth` is the existing guard rather than
 * anything new. Any active role may ask for a quote.
 *
 * The quote is deliberately **not** attached to the authenticated user. This
 * phase has no passenger ownership and no RideRequest; the caller is
 * authenticated but not recorded. When ride requests arrive, the request -- not
 * the quote -- is what will reference a passenger.
 *
 * The guard is mounted on this route rather than on the router, so an unknown
 * path under /api/fare-quotes still answers 404 rather than 401.
 */
router.post('/', requireAuth, fare.createFareQuote);

export default router;
