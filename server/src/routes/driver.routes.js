import { Role } from '@prisma/client';
import { Router } from 'express';

import * as driver from '../controllers/driver.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Mounted at /api/drivers.
const router = Router();

/**
 * Driver availability and the offers a driver can see.
 *
 * Only a DRIVER may use any of these, and only ever for themselves: `requireAuth`
 * loads the user, `requireRole` checks the role against the database record, and
 * every handler takes the driver from that record. Nothing accepts a driver id,
 * so "another driver's availability" is not an addressable resource.
 *
 * The guards are mounted per route rather than on the router, so a path that does
 * not exist under /api/drivers still answers 404 rather than 401 -- the same
 * choice the fare routes make.
 */

router.get('/me/availability', requireAuth, requireRole(Role.DRIVER), driver.getAvailability);
router.post('/me/online', requireAuth, requireRole(Role.DRIVER), driver.goOnline);
router.post('/me/offline', requireAuth, requireRole(Role.DRIVER), driver.goOffline);
router.put(
  '/me/current-service-point',
  requireAuth,
  requireRole(Role.DRIVER),
  driver.setCurrentServicePoint,
);

router.get('/me/offers', requireAuth, requireRole(Role.DRIVER), driver.listOffers);
router.get('/me/offers/:offerId', requireAuth, requireRole(Role.DRIVER), driver.getOffer);
router.post('/me/offers/:offerId/accept', requireAuth, requireRole(Role.DRIVER), driver.acceptOffer);
router.post('/me/offers/:offerId/reject', requireAuth, requireRole(Role.DRIVER), driver.rejectOffer);

/** The read side of acceptance: the pool this driver is currently committed to. */
router.get('/me/pool', requireAuth, requireRole(Role.DRIVER), driver.getCurrentPool);

export default router;
