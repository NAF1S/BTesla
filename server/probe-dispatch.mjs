import { disconnect, prisma } from './src/db/prisma.js';
import { createSoloFareQuote } from './src/services/fare.service.js';
import { createRideRequest, listRideEvents } from './src/services/ride-request.service.js';
import * as driverService from './src/services/driver.service.js';
import * as dispatchService from './src/services/dispatch.service.js';
import * as offerService from './src/services/offer.service.js';
import { listPoolEvents } from './src/services/pool.service.js';

/** Temporary smoke probe (deleted after use). */

const load = async (email) =>
  prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      role: true,
      passengerProfile: { select: { id: true } },
      driverProfile: { select: { id: true, status: true } },
    },
  });

const nusrat = await load('nusrat@example.com');
const jashim = await load('jashim@example.com');

await prisma.$executeRawUnsafe(`DELETE FROM ride_requests`);
await prisma.driverProfile.update({
  where: { id: jashim.driverProfile.id },
  data: {
    status: 'OFFLINE',
    currentServicePointId: null,
    availableSince: null,
    lastSeenAt: null,
    activeVehicleId: null,
  },
});

const online = await driverService.goOnline({
  driver: jashim,
  currentServicePointCode: 'banani-kakoli',
});
console.log('online:', online.status, 'at', online.currentServicePoint.code, 'vehicle', online.activeVehicle.name);

const { quote } = await createSoloFareQuote({
  passengerProfileId: nusrat.passengerProfile.id,
  originServicePointCode: 'banani-road-11',
  destinationServicePointCode: 'mohakhali-bus-terminal',
  departureAt: new Date('2026-09-24T08:41:00+06:00'),
});

const { request } = await createRideRequest({
  passenger: nusrat,
  fareQuoteId: quote.id,
  idempotencyKey: `probe-${Date.now()}`,
});

const dispatched = await dispatchService.dispatchWaitingRequest({ rideRequestId: request.id });
console.log('dispatch:', JSON.stringify(dispatched));

const offer = await offerService.findOfferForDriver({
  driver: jashim,
  offerId: dispatched.offerId,
});
console.log('offer:', JSON.stringify(offer, null, 1));

const { pool } = await offerService.acceptOffer({ driver: jashim, offerId: dispatched.offerId });
console.log('pool:', JSON.stringify(pool, null, 1));

console.log(
  'events:',
  (await listRideEvents(request.id)).map((e) => e.eventType).join(','),
  '|',
  (await listPoolEvents(pool.id)).map((e) => e.eventType).join(','),
);

const after = await prisma.driverProfile.findUnique({
  where: { id: jashim.driverProfile.id },
  select: { status: true },
});
const requestAfter = await prisma.rideRequest.findUnique({
  where: { id: request.id },
  select: { status: true },
});
console.log('driver:', after.status, 'request:', requestAfter.status);

await disconnect();
