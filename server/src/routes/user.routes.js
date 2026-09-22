import { Router } from 'express';

import * as users from '../controllers/user.controller.js';

const router = Router();

router.get('/', users.listUsers);
router.get('/:id', users.getUser);
router.post('/', users.createUser);

export default router;
