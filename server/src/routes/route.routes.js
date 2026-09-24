import { Router } from 'express';

import * as route from '../controllers/route.controller.js';
import { requireAuth } from '../middleware/auth.js';

// Mounted at /api/routes.
const router = Router();

/**
 * Point-to-point route estimate.
 *
 * Authentication is required. `requireAuth` is the existing guard used by the
 * rest of the API: it verifies the signed JWT in the HttpOnly cookie and then
 * re-loads the active user from the database, so a deactivated or deleted
 * account is rejected on the very next request whatever its token claims.
 *
 * Any active role may estimate a route -- a passenger planning a trip and a
 * driver checking a pickup are equally entitled to it -- so there is no
 * `requireRole` here. No new authentication mechanism was introduced.
 *
 * The guard is mounted on this route rather than on the router, so an unknown
 * path under /api/routes still answers 404 rather than 401 and does not reveal
 * that it is behind a guard.
 */
router.post('/estimate', requireAuth, route.estimateRoute);

export default router;
