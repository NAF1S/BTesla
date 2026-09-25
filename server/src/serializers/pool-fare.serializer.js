import { formatMoney } from '../services/fare.calculator.js';

/**
 * The passenger's view of what they are being charged.
 *
 * A whitelist, like every serializer here, and the whitelist is the privacy
 * policy: this DTO is derived from **one** passenger's allocation, so there is no
 * shape of response in which another passenger's fare, the pool's revenue, or the
 * platform's share of somebody else's minimum fare could appear. The serializer
 * is not given those numbers at all.
 *
 * `totalReduction` answers the question a passenger actually has -- "what has
 * sharing saved me?" -- and the fields underneath it answer the more precise one:
 * whether a *cap* brought the fare down (they were protected) or whether sharing
 * did. `savedAgainstSoloFare` is the difference against the quote they accepted.
 *
 * `fareStatus` is `ESTIMATED` for every calculation this milestone can produce: a
 * fare is settled by the trip milestone, which is what sets `FINALIZED`. The
 * calculation's own status is exposed as `calculationStatus`, so a client can tell
 * a current answer from a superseded one.
 */
export const toPassengerFareDto = ({
  rideRequestId,
  calculation,
  allocation,
  legsPaidFor,
  roundingScale,
}) => {
  const scale = roundingScale;
  const totalReduction = allocation.soloCapReduction.plus(allocation.noIncreaseReduction);

  return {
    rideRequestId,
    fareStatus: calculation.status === 'FINALIZED' ? 'FINALIZED' : 'ESTIMATED',
    calculationStatus: calculation.status,
    currency: calculation.currency,

    // The numbers that answer "what do I owe, and why".
    acceptedSoloFare: formatMoney(allocation.acceptedSoloFare, scale),
    currentPooledFare: formatMoney(allocation.finalFare, scale),
    baseFare: formatMoney(allocation.baseFare, scale),
    allocatedLegCost: formatMoney(allocation.allocatedLegCost, scale),
    uncappedPooledFare: formatMoney(allocation.uncappedPooledFare, scale),
    minimumFare: formatMoney(allocation.minimumFare, scale),
    minimumFareApplied: allocation.minimumFareApplied,
    legsPaidFor,

    // The protections, and what each of them took off.
    previousPooledFare:
      allocation.previousPooledFareCap === null
        ? null
        : formatMoney(allocation.previousPooledFareCap, scale),
    soloCapApplied: allocation.soloCapApplied,
    noIncreaseCapApplied: allocation.noIncreaseCapApplied,
    soloCapReduction: formatMoney(allocation.soloCapReduction, scale),
    noIncreaseReduction: formatMoney(allocation.noIncreaseReduction, scale),
    totalReduction: formatMoney(totalReduction, scale),
    savedAgainstSoloFare: formatMoney(
      allocation.acceptedSoloFare.minus(allocation.finalFare),
      scale,
    ),

    // Which rules produced this number. A client can show them; a client cannot
    // choose them.
    pricingCode: calculation.pricingCode,
    pricingVersion: calculation.pricingVersion,
    sharedFareRuleVersion: calculation.sharedFareRuleVersion,
    poolVersion: calculation.poolVersion,
    calculatedAt: new Date(calculation.createdAt).toISOString(),
  };
};
