import { Router } from 'express';

import healthRoutes from './health.routes.js';
import locationRoutes from './location.routes.js';
import userRoutes from './user.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/location', locationRoutes);
router.use('/users', userRoutes);

export default router;
