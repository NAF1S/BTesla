import { Role } from '@prisma/client';
import { Router } from 'express';

import * as users from '../controllers/user.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// NOTE: the read endpoints are still public so the Next.js demo page, which
// fetches them server-side without credentials, keeps working. Tightening them
// is a follow-up once the client can send the authentication cookie.
router.get('/', users.listUsers);
router.get('/:id', users.getUser);

// Creating accounts is an administrative action: public sign-up is out of scope
// for the MVP (accounts come from the seed), and gating it here is also what
// stops a client from choosing ADMIN for a new account.
router.post('/', requireAuth, requireRole(Role.ADMIN), users.createUser);

export default router;
