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
router.patch('/me/availability', requireAuth, requireRole(Role.DRIVER), driver.setAvailability);
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

/**
 * The read side of acceptance: the pool this driver is currently committed to --
 * the one row a client polls to know what to do next.
 *
 * Two paths, one handler. `/me/current-pool` is the name the trip milestone
 * documents, because "the pool I am committed to" and "the pool I am driving" are
 * the same row read at different moments, and the trip's `allowedActions` is what
 * distinguishes them. `/me/pool` was the name the matching milestone published and
 * is kept as an alias so an existing caller does not break.
 */
router.get('/me/current-pool', requireAuth, requireRole(Role.DRIVER), driver.getCurrentPool);
router.get('/me/pool', requireAuth, requireRole(Role.DRIVER), driver.getCurrentPool);

/**
 * The trip itself, in the order a driver performs it: set off, reach a stop,
 * collect, start, deliver, finish.
 *
 * Every path names the pool, and the stop and passenger paths name the row they
 * act on -- so a command cannot be aimed at "the current stop" by a client whose
 * idea of where the driver is has gone stale. The driver is never named: they
 * come from the session, and a pool that is not theirs is a 404 rather than a
 * 403, so these paths cannot be used to discover other drivers' work.
 */
router.post('/me/pools/:poolId/depart', requireAuth, requireRole(Role.DRIVER), driver.departPool);
router.post(
  '/me/pools/:poolId/stops/:stopId/arrive',
  requireAuth,
  requireRole(Role.DRIVER),
  driver.arriveAtStop,
);
router.post(
  '/me/pools/:poolId/stops/:stopId/members/:memberId/pickup',
  requireAuth,
  requireRole(Role.DRIVER),
  driver.pickUpMember,
);
router.post('/me/pools/:poolId/start', requireAuth, requireRole(Role.DRIVER), driver.startTrip);
router.post(
  '/me/pools/:poolId/stops/:stopId/members/:memberId/dropoff',
  requireAuth,
  requireRole(Role.DRIVER),
  driver.dropOffMember,
);
router.post(
  '/me/pools/:poolId/complete',
  requireAuth,
  requireRole(Role.DRIVER),
  driver.completeTrip,
);

/**
 * The driver's own ride history, and one ride in detail.
 *
 * Read-only, and the unit is a *pool*: one car's journey, however many passengers
 * were in it. `/me/rides` is a sibling of `/me/pools` rather than a path under it,
 * because a history is not an operation on a pool that exists yet -- the list is
 * the entry point, and the detail names one pool.
 *
 * Both are DRIVER-only, and neither accepts a driver id: a pool that is not this
 * driver's is a 404.
 */
router.get('/me/rides', requireAuth, requireRole(Role.DRIVER), driver.listMyRides);
router.get('/me/rides/:poolId', requireAuth, requireRole(Role.DRIVER), driver.getMyRide);

export default router;
