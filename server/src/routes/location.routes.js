import { Router } from 'express';

import * as location from '../controllers/location.controller.js';

// Mounted at /api/location.
const router = Router();

router.get('/zones', location.listZones);

router.get('/points', location.listPoints);
router.get('/points/:code', location.getPoint);

export default router;
