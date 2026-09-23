import { Router } from 'express';

import * as auth from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.js';

// Mounted at /api/auth.
const router = Router();

router.post('/login', auth.login);
router.post('/register', auth.register);
router.get('/me', requireAuth, auth.me);
// Intentionally unguarded so a stale or expired cookie can always be removed.
router.post('/logout', auth.logout);

export default router;
