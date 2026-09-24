import { Router } from 'express';

import * as route from '../controllers/route.controller.js';

// Mounted at /api/routes.
const router = Router();

/**
 * Point-to-point route estimate.
 *
 * Public, like the location reads it builds on: it reports what the stored graph
 * already says and writes nothing, so there is no session to require. When ride
 * requests arrive in a later milestone they will be authenticated, and this
 * endpoint can be gated with the existing `requireAuth` middleware at that
 * point without changing its contract.
 */
router.post('/estimate', route.estimateRoute);

export default router;
