import { Router } from 'express';

import * as transport from '../controllers/transport.controller.js';

const router = Router();

// Mounted at /api/transport.
router.get('/zones', transport.listZones);

router.get('/stops', transport.listStops);
router.get('/stops/:code', transport.getStop);

router.get('/corridors', transport.listCorridors);
// '/corridors/match' must be declared before the '/corridors/:code' pattern.
router.get('/corridors/match', transport.matchCorridors);
router.get('/corridors/:code', transport.getCorridor);

router.get('/travel-estimates', transport.getTravelEstimate);

export default router;
