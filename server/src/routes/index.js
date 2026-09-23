import { Router } from 'express';

import healthRoutes from './health.routes.js';
import transportRoutes from './transport.routes.js';
import userRoutes from './user.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/transport', transportRoutes);
router.use('/users', userRoutes);

export default router;
