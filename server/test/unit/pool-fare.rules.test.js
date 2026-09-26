import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { FareCalculationError } from '../../src/services/fare.calculator.js';
import {
  PLAN_REJECTION,
  POOL_FARE_STATUSES,
  PoolFareError,
  SHARED_FARE_RULE_VERSION,
  SHARE_RATIO_SCALE,
  allocateLegShares,
  computeLegCost,
  computePassengerFare,
  isCurrentRuleVersion,
  onboardByLeg,
  stableMemberOrder,
  sumAmounts,
  totalise,
} from '../../src/services/pool-fare.rules.js';

/**
 * The shared-fare rules are the whole promise: who pays for which leg, how a
 * leg is split, and what stops a fare from going up. They are pure, so all of
 * that can be pinned down here with amounts a reader can check by hand -- no
 * database, no router, no clock.
 *
 * The fixture policy is the seeded one, at its real rates: 40.00 base, 18.00 per
 * kilometre, 2.00 per minute, 80.00 minimum, 1.00 off-peak and 1.10 at rush
 * hour, rounded HALF_UP to two decimals, with every charged fare snapped to a
 * whole 10 taka.
 */

const { Decimal } = Prisma;

const POLICY = Object.freeze({
  code: 'dhaka-solo',
  version: 1,
  currency: 'BDT',
  roundingScale: 2,
  quoteTtlSeconds: 300,
  baseFare: new Decimal('40.0000'),
  perKilometerRate: new Decimal('18.0000'),
  perMinuteRate: new Decimal('2.0000'),
  minimumFare: new Decimal('80.0000'),
  normalTrafficMultiplier: new Decimal('1.0000'),
  rushHourMultiplier: new Decimal('1.1000'),
  fareRoundingUnit: new Decimal('10.0000'),
});

/** One routed edge of a kilometre in two minutes: 18.00 of distance, 4.00 of time. */
const edge = (edgeCode, { meters = 1000, seconds = 120, weight = '1.000' } = {}) => ({
  edgeCode,
  direction: 'FORWARD',
  distanceMeters: meters,
  durationSeconds: seconds,
  fareWeight: new Decimal(weight),
});

const stop = (sequence, stopType, poolMemberId, id = `stop-${sequence}`) => ({
  id,
  sequence,
  stopType,
  poolMemberId,
  servicePointId: `point-${sequence}`,
});

const member = (id) => ({ id, rideRequestId: `request-${id}` });

const legsFor = (stops, capacities = 3, members = [...new Set(stops.map((s) => s.poolMemberId))].map(member)) =>
  onboardByLeg({ stops, members, capacity: capacities });

// --- Rule-set identity --------------------------------------------------

describe('the shared-fare rule version', () => {
  it('names itself and tells an older calculation apart', () => {
    assert.strictEqual(SHARED_FARE_RULE_VERSION, 'pool-leg-share-v2');
    assert.strictEqual(isCurrentRuleVersion(SHARED_FARE_RULE_VERSION), true);
    assert.strictEqual(isCurrentRuleVersion('pool-leg-share-v0'), false);
    assert.strictEqual(isCurrentRuleVersion(null), false);
  });

  it('has three calculation statuses, and CURRENT is the one in force', () => {
    assert.deepStrictEqual([...POOL_FARE_STATUSES].sort(), ['CURRENT', 'FINALIZED', 'SUPERSEDED']);
    assert.ok(Object.isFrozen(POOL_FARE_STATUSES));
  });
});

// ========================================================================
// Categories 1-7: who is on board, and when
// ========================================================================

describe('onboard determination', () => {
  it('puts a passenger on board after their pickup (categories 1, 3)', () => {
    const { legs, timeline } = legsFor([
      stop(1, 'PICKUP', 'member-a'),
      stop(2, 'DROPOFF', 'member-a'),
    ]);

    assert.strictEqual(legs.length, 1, 'two stops make one leg');
    assert.deepStrictEqual(legs[0].onboardMemberIds, ['member-a']);
    assert.deepStrictEqual(timeline, [
      { sequence: 1, stopType: 'PICKUP', occupancyAfter: 1 },
      { sequence: 2, stopType: 'DROPOFF', occupancyAfter: 0 },
    ]);
  });

  it('takes a passenger off the moment they are delivered (category 2)', () => {
    // A is delivered at stop 2, so A pays only for leg 1 -- not for the travel
    // between stops 2 and 3, which happens after they are out of the car.
    const { legs } = legsFor([
      stop(1, 'PICKUP', 'member-a'),
      stop(2, 'DROPOFF', 'member-a'),
      stop(3, 'PICKUP', 'member-b'),
      stop(4, 'DROPOFF', 'member-b'),
    ]);

    assert.deepStrictEqual(
      legs.map((leg) => leg.onboardMemberIds),
      [['member-a'], [], ['member-b']],
      'the middle leg has nobody on board, so nobody pays for it',
    );
  });

  it('never charges a passenger for a leg before their pickup or after their drop-off (categories 3, 4)', () => {
    const { legs } = legsFor([
      stop(1, 'PICKUP', 'member-a'),
      stop(2, 'PICKUP', 'member-b'),
      stop(3, 'DROPOFF', 'member-a'),
      stop(4, 'DROPOFF', 'member-b'),
    ]);

    assert.deepStrictEqual(
      legs.map((leg) => leg.onboardMemberIds),
      [['member-a'], ['member-a', 'member-b'], ['member-b']],
    );

    // A is not on the leg that ends at B's drop-off, and B is not on the leg
    // that ends at A's drop-off.
    assert.ok(!legs[2].onboardMemberIds.includes('member-a'));
    assert.ok(!legs[0].onboardMemberIds.includes('member-b'));
  });

  it('rejects a plan whose stop order and members disagree (category 5)', () => {
    const cases = [
      [
        'a drop-off before its pickup',
        [stop(1, 'DROPOFF', 'member-a'), stop(2, 'PICKUP', 'member-a')],
        PLAN_REJECTION.DROPOFF_BEFORE_PICKUP,
      ],
      [
        'a pickup after the delivery',
        [stop(1, 'PICKUP', 'member-a'), stop(2, 'DROPOFF', 'member-a'), stop(3, 'PICKUP', 'member-a')],
        PLAN_REJECTION.DROPOFF_BEFORE_PICKUP,
      ],
      [
        'a stop for somebody who is not in the pool',
        [stop(1, 'PICKUP', 'member-a'), stop(2, 'DROPOFF', 'ghost')],
        PLAN_REJECTION.UNKNOWN_MEMBER,
        [member('member-a')],
      ],
      [
        'an unknown stop type',
        [stop(1, 'PICKUP', 'member-a'), stop(2, 'SIGHTSEEING', 'member-a')],
        PLAN_REJECTION.UNKNOWN_STOP_TYPE,
      ],
      [
        'sequence numbers with a hole in them',
        [stop(1, 'PICKUP', 'member-a'), stop(3, 'DROPOFF', 'member-a')],
        PLAN_REJECTION.NON_CONTIGUOUS_SEQUENCE,
      ],
      ['no stops at all', [], PLAN_REJECTION.NO_STOPS],
    ];

    for (const [description, stops, reason, members] of cases) {
      assert.throws(
        () => onboardByLeg({ stops, members: members ?? [...new Set(stops.map((s) => s.poolMemberId))].map(member), capacity: 3 }),
        (err) => err instanceof PoolFareError && err.reason === reason,
        description,
      );
    }
  });

  it('rejects a passenger collected or delivered twice (category 6)', () => {
    assert.throws(
      () =>
        legsFor([
          stop(1, 'PICKUP', 'member-a'),
          stop(2, 'PICKUP', 'member-a'),
          stop(3, 'DROPOFF', 'member-a'),
        ]),
      (err) => err.reason === PLAN_REJECTION.DUPLICATE_STOP && /collected twice/.test(err.message),
    );

    assert.throws(
      () =>
        legsFor([
          stop(1, 'PICKUP', 'member-a'),
          stop(2, 'DROPOFF', 'member-a'),
          stop(3, 'DROPOFF', 'member-a'),
        ]),
      (err) => err.reason === PLAN_REJECTION.DUPLICATE_STOP && /delivered twice/.test(err.message),
    );
  });

  it('rejects a member who has only one of their two stops (category 7)', () => {
    // B is a member of the pool but never appears in the plan: there is no way
    // to say what B should be charged, so this is refused rather than priced.
    assert.throws(
      () =>
        onboardByLeg({
          stops: [stop(1, 'PICKUP', 'member-a'), stop(2, 'DROPOFF', 'member-a')],
          members: [member('member-a'), member('member-b')],
          capacity: 3,
        }),
      (err) => err.reason === PLAN_REJECTION.MISSING_STOP && /member-b/.test(err.message),
    );

    // Only a pickup, with no delivery anywhere in the plan.
    assert.throws(
      () => legsFor([stop(1, 'PICKUP', 'member-a'), stop(2, 'PICKUP', 'member-b'), stop(3, 'DROPOFF', 'member-b')]),
      (err) => err.reason === PLAN_REJECTION.MISSING_STOP,
    );
  });

  it('rejects a plan that would put more passengers in the car than it holds', () => {
    const twoTogether = [stop(1, 'PICKUP', 'member-a'), stop(2, 'PICKUP', 'member-b'), stop(3, 'DROPOFF', 'member-a'), stop(4, 'DROPOFF', 'member-b')];

    assert.throws(
      () => legsFor(twoTogether, 1),
      (err) => err.reason === PLAN_REJECTION.OCCUPANCY && /2 passengers would be in a 1-seat/.test(err.message),
    );

    // The same plan is legal in a two-seat car, and legal in a one-seat car
    // once the two passengers are never in it at the same time.
    assert.strictEqual(legsFor(twoTogether, 2).legs.length, 3);
    assert.deepStrictEqual(
      legsFor(
        [stop(1, 'PICKUP', 'member-a'), stop(2, 'DROPOFF', 'member-a'), stop(3, 'PICKUP', 'member-b'), stop(4, 'DROPOFF', 'member-b')],
        1,
      ).legs.map((leg) => leg.onboardMemberIds.length),
      [1, 0, 1],
    );
  });

  it('prices a plan whose legs cover every consecutive pair of stops', () => {
    const { legs } = legsFor([
      stop(1, 'PICKUP', 'member-a'),
      stop(2, 'PICKUP', 'member-b'),
      stop(3, 'DROPOFF', 'member-b'),
      stop(4, 'DROPOFF', 'member-a'),
    ]);

    assert.strictEqual(legs.length, 3);
    assert.deepStrictEqual(
      legs.map((leg) => `${leg.sequence}:${leg.fromStop.sequence}->${leg.toStop.sequence}`),
      ['1:1->2', '2:2->3', '3:3->4'],
    );
  });
});

// ========================================================================
// Categories 8-13: what a leg costs
// ========================================================================

describe('leg cost', () => {
  const costOf = (edges, trafficProfile = 'NORMAL') =>
    computeLegCost({ policy: POLICY, edges, trafficProfile });

  it('prices network distance, not a straight line (category 8)', () => {
    // Two kilometres of routed edge: 2 km x 18.00 = 36.00 of distance, and
    // 240 seconds = 4 minutes x 2.00 = 8.00 of time.
    const cost = costOf([edge('e1'), edge('e2')]);

    assert.strictEqual(cost.distanceMeters, 2000);
    assert.strictEqual(cost.distanceCost.toFixed(6), '36.000000');
    assert.strictEqual(cost.timeCost.toFixed(6), '8.000000');
    assert.strictEqual(cost.totalLegCost.toFixed(6), '44.000000');
  });

  it('applies each edge its own fare weight (category 9)', () => {
    const weighted = costOf([edge('e1'), edge('e2', { weight: '1.500' })]);

    // 18.00 for the first edge, 27.00 for the weighted one.
    assert.strictEqual(weighted.distanceCost.toFixed(6), '45.000000');
    assert.deepStrictEqual(
      weighted.edges.map((priced) => priced.distanceCharge.toFixed(2)),
      ['18.00', '27.00'],
    );

    // The weight multiplies distance only: the duration is untouched.
    assert.strictEqual(weighted.durationSeconds, 240);
    assert.strictEqual(weighted.timeCost.toFixed(6), '8.000000');
  });

  it('prices time from the routed duration (category 10)', () => {
    const slow = costOf([edge('e1', { seconds: 600 })]);

    assert.strictEqual(slow.durationSeconds, 600);
    assert.strictEqual(slow.timeCost.toFixed(6), '20.000000', '10 minutes at 2.00');
    assert.strictEqual(slow.distanceCost.toFixed(6), '18.000000');
  });

  it('applies the traffic multiplier exactly once (category 11)', () => {
    const peak = costOf([edge('e1'), edge('e2')], 'RUSH_HOUR');
    const offPeak = costOf([edge('e1'), edge('e2')], 'NORMAL');

    // 44.00 of pre-traffic cost, 10% of it added once: 4.40.
    assert.strictEqual(peak.preTrafficCost.toFixed(6), '44.000000');
    assert.strictEqual(peak.trafficAdjustment.toFixed(6), '4.400000');
    assert.strictEqual(peak.totalLegCost.toFixed(6), '48.400000');

    // 48.40, not 53.24: the multiplier is not applied twice, and not applied to
    // the distance and the time separately either.
    assert.notStrictEqual(peak.totalLegCost.toFixed(6), '53.240000');
    assert.strictEqual(
      peak.totalLegCost.toFixed(6),
      peak.preTrafficCost.plus(peak.trafficAdjustment).toFixed(6),
      'the stored components add up to the stored total',
    );

    // Off-peak the multiplier is 1.00, so there is no adjustment at all.
    assert.strictEqual(offPeak.trafficAdjustment.toFixed(6), '0.000000');
    assert.strictEqual(offPeak.totalLegCost.toFixed(6), '44.000000');
  });

  it('never includes a base fare in the cost of a leg (category 12)', () => {
    const cost = costOf([edge('e1')]);

    // 18.00 of distance plus 4.00 of time. The policy's 40.00 base fare belongs
    // to the passenger, not to the leg.
    assert.strictEqual(cost.totalLegCost.toFixed(6), '22.000000');
    assert.ok(!Object.keys(cost).includes('baseFare'));
  });

  it('records the edges it priced, so the leg can be reproduced (category 13)', () => {
    const cost = costOf([edge('e1', { meters: 1500 }), edge('e2', { seconds: 90, weight: '1.200' })]);

    assert.deepStrictEqual(
      cost.edges.map((priced) => ({
        edgeCode: priced.edgeCode,
        distanceMeters: priced.distanceMeters,
        durationSeconds: priced.durationSeconds,
        fareWeight: priced.fareWeight.toFixed(3),
        kilometers: priced.kilometers.toFixed(3),
        distanceCharge: priced.distanceCharge.toFixed(2),
      })),
      [
        {
          edgeCode: 'e1',
          distanceMeters: 1500,
          durationSeconds: 120,
          fareWeight: '1.000',
          kilometers: '1.500',
          distanceCharge: '27.00',
        },
        {
          edgeCode: 'e2',
          distanceMeters: 1000,
          durationSeconds: 90,
          fareWeight: '1.200',
          kilometers: '1.000',
          distanceCharge: '21.60',
        },
      ],
    );

    // The same edges always price the same way: nothing here reads a clock.
    assert.strictEqual(
      cost.totalLegCost.toFixed(6),
      costOf([edge('e1', { meters: 1500 }), edge('e2', { seconds: 90, weight: '1.200' })]).totalLegCost.toFixed(6),
    );
  });

  it('refuses a leg it cannot price', () => {
    assert.throws(() => costOf([]), (err) => err.reason === PLAN_REJECTION.UNROUTABLE);
    assert.throws(
      () => costOf([edge('e1', { weight: '0.000' })]),
      (err) => err.reason === PLAN_REJECTION.UNROUTABLE,
    );
    assert.throws(() => costOf([{ ...edge('e1'), edgeCode: null }]), (err) => err.reason === PLAN_REJECTION.UNROUTABLE);
  });
});

// ========================================================================
// Categories 14-19: splitting a leg
// ========================================================================

describe('cost sharing', () => {
  const share = (total, memberIds, scale = 2) =>
    allocateLegShares({
      totalLegCost: new Decimal(total),
      onboardMemberIds: memberIds,
      scale,
    });

  const allocated = (shares) => shares.map((one) => one.allocatedAmount.toFixed(2));

  it('gives one passenger the whole leg (category 14)', () => {
    const shares = share('44.00', ['member-a']);

    assert.strictEqual(shares.length, 1);
    assert.deepStrictEqual(allocated(shares), ['44.00']);
    assert.strictEqual(shares[0].shareRatio, '1.0000000000');
    assert.strictEqual(shares[0].roundingAdjustment.toFixed(6), '0.000000');
    assert.strictEqual(shares[0].onboardPassengerCount, 1);
  });

  it('splits a leg equally between two passengers (category 15)', () => {
    const shares = share('40.00', ['member-a', 'member-b']);

    assert.deepStrictEqual(allocated(shares), ['20.00', '20.00']);
    assert.strictEqual(shares[0].unroundedAmount.toFixed(6), '20.000000');
    assert.strictEqual(shares[0].shareRatio, '0.5000000000');
  });

  it('splits a leg between three passengers (category 16)', () => {
    const shares = share('30.00', ['member-a', 'member-b', 'member-c']);

    assert.deepStrictEqual(allocated(shares), ['10.00', '10.00', '10.00']);
    assert.strictEqual(shares[0].unroundedAmount.toFixed(4), '10.0000');
    assert.strictEqual(shares[0].shareRatio, '0.3333333333');
  });

  it('makes the rounded shares add up to the leg total exactly (category 17)', () => {
    // 10.00 between three: the quotient is 3.333333..., so two passengers are
    // given a third of it down and the third receives the residual paisa.
    const shares = share('10.00', ['member-a', 'member-b', 'member-c']);

    assert.deepStrictEqual(allocated(shares), ['3.34', '3.33', '3.33']);
    assert.strictEqual(
      sumAmounts(shares.map((one) => one.allocatedAmount)).toFixed(6),
      '10.000000',
      'the shares add up to the cost: no money is discarded or invented',
    );
  });

  it('always conserves the total, whatever the amount (category 17)', () => {
    const amounts = ['0.01', '0.10', '1.00', '9.99', '33.33', '100.00', '1234.56', '999.99'];
    const counts = [1, 2, 3, 4, 5];

    for (const total of amounts) {
      for (const count of counts) {
        const memberIds = Array.from({ length: count }, (_, index) => `member-${index}`);
        const shares = share(total, memberIds);

        assert.strictEqual(
          sumAmounts(shares.map((one) => one.allocatedAmount)).toFixed(6),
          new Decimal(total).toFixed(6),
          `${total} split ${count} ways`,
        );

        // No share is ever more than one currency unit away from another.
        const spread = Decimal.max(...shares.map((one) => one.allocatedAmount)).minus(
          Decimal.min(...shares.map((one) => one.allocatedAmount)),
        );
        assert.ok(spread.lte('0.01'), `${total} split ${count} ways is uneven by ${spread.toString()}`);
      }
    }
  });

  it('hands the residual out deterministically, in member order (category 18)', () => {
    const first = share('10.00', ['member-c', 'member-a', 'member-b']);
    const second = share('10.00', ['member-b', 'member-c', 'member-a']);

    const payable = (shares) =>
      Object.fromEntries(shares.map((one) => [one.poolMemberId, one.allocatedAmount.toFixed(2)]));

    // The same three passengers pay the same amounts in either input order, and
    // the extra paisa goes to the lowest member id.
    assert.deepStrictEqual(payable(first), payable(second));
    assert.deepStrictEqual(payable(first), {
      'member-a': '3.34',
      'member-b': '3.33',
      'member-c': '3.33',
    });
    assert.deepStrictEqual(stableMemberOrder(['b', 'c', 'a']), ['a', 'b', 'c']);
  });

  it('stores the residual it applied (category 17)', () => {
    const shares = share('10.00', ['member-a', 'member-b', 'member-c']);
    const byMember = Object.fromEntries(shares.map((one) => [one.poolMemberId, one]));

    const exact = new Decimal('10.00').div(3);

    // The adjustment is the exact difference between the charge and the true
    // quotient: a third of 10.00 is 3.3333..., so the passenger who received the
    // residual unit is 0.006666... above their exact share and the other two are
    // 0.003333... below theirs. Nothing is hidden by rounding.
    assert.strictEqual(
      byMember['member-a'].roundingAdjustment.toFixed(6),
      byMember['member-a'].allocatedAmount.minus(exact).toFixed(6),
    );
    assert.strictEqual(byMember['member-a'].roundingAdjustment.toFixed(6), '0.006667');
    assert.strictEqual(byMember['member-b'].roundingAdjustment.toFixed(6), '-0.003333');
    assert.strictEqual(byMember['member-c'].roundingAdjustment.toFixed(6), '-0.003333');
    assert.strictEqual(
      sumAmounts(shares.map((one) => one.roundingAdjustment)).toFixed(6),
      '0.000000',
      'the adjustments cancel out exactly, because the shares sum to the cost',
    );
  });

  it('refuses to share a leg with nobody on board (category 19)', () => {
    assert.throws(
      () => share('10.00', []),
      (err) => err.reason === PLAN_REJECTION.UNBALANCED_LEG,
    );
  });

  it('only ever produces a share for a passenger it was given (category 19)', () => {
    const shares = share('12.00', ['member-a', 'member-b']);

    assert.deepStrictEqual(
      shares.map((one) => one.poolMemberId).sort(),
      ['member-a', 'member-b'],
    );
  });
});

// ========================================================================
// Categories 20-26: the protections
// ========================================================================

describe('passenger protections', () => {
  const fareFor = (overrides = {}) =>
    computePassengerFare({
      policy: POLICY,
      allocatedLegCost: new Decimal('100.00'),
      acceptedSoloFare: new Decimal('180.00'),
      previousPooledFareCap: null,
      ...overrides,
    });

  it('takes the base fare plus the passenger\'s share of the legs', () => {
    const fare = fareFor();

    assert.strictEqual(fare.baseFare.toFixed(2), '40.00');
    assert.strictEqual(fare.uncappedPooledFare.toFixed(2), '140.00');
    assert.strictEqual(fare.finalFare.toFixed(2), '140.00');
    assert.strictEqual(fare.minimumFareApplied, false);
    assert.strictEqual(fare.soloCapApplied, false);
  });

  it('never charges more than the accepted solo fare (category 20)', () => {
    const fare = fareFor({ allocatedLegCost: new Decimal('400.00') });

    assert.strictEqual(fare.uncappedPooledFare.toFixed(2), '440.00');
    assert.strictEqual(fare.finalFare.toFixed(2), '180.00');
    assert.strictEqual(fare.soloCapApplied, true);
    assert.strictEqual(fare.soloCapReduction.toFixed(2), '260.00', '440.00 reduced to 180.00');
    assert.ok(fare.finalFare.lte('180.00'));
  });

  it('reduces a fare to the fare that passenger was last given (categories 21, 22)', () => {
    // The cap is a whole number of units, as every stored fare is -- see the
    // caps-are-whole-units test below for what happens when it is not.
    const fare = fareFor({ previousPooledFareCap: new Decimal('90.00') });

    assert.strictEqual(fare.uncappedPooledFare.toFixed(2), '140.00');
    assert.strictEqual(fare.unroundedFare.toFixed(2), '90.00');
    assert.strictEqual(fare.finalFare.toFixed(2), '90.00', 'the previous fare is a ceiling');
    assert.strictEqual(fare.noIncreaseCapApplied, true);
    assert.strictEqual(fare.noIncreaseReduction.toFixed(2), '50.00');
    assert.strictEqual(fare.soloCapApplied, false);
  });

  it('applies both caps when both bind, and records each separately (categories 24, 25)', () => {
    const fare = fareFor({
      allocatedLegCost: new Decimal('600.00'),
      previousPooledFareCap: new Decimal('170.00'),
    });

    // 640.00 uncapped, capped to the 180.00 quote, then to the 170.00 previous
    // fare: 10.00 of solo reduction and 170.00... no -- 640 -> 180 is 460, and
    // 180 -> 170 is 10.
    assert.strictEqual(fare.soloCapReduction.toFixed(2), '460.00');
    assert.strictEqual(fare.noIncreaseReduction.toFixed(2), '10.00');
    assert.strictEqual(fare.finalFare.toFixed(2), '170.00');
    assert.strictEqual(fare.soloCapApplied, true);
    assert.strictEqual(fare.noIncreaseCapApplied, true);
  });

  it('snaps the protected fare to the unit and records what that moved (category 26)', () => {
    const fare = fareFor({ allocatedLegCost: new Decimal('100.63') });

    // 40.00 base + 100.63 of legs = 140.63, which a whole number of 10 taka
    // rounds to 140. The components keep their two decimals; only the charge is
    // snapped, and the 0.63 is written down rather than lost.
    assert.strictEqual(fare.uncappedPooledFare.toFixed(2), '140.63');
    assert.strictEqual(fare.unroundedFare.toFixed(2), '140.63');
    assert.strictEqual(fare.fareRoundingAdjustment.toFixed(2), '-0.63');
    assert.strictEqual(fare.finalFare.toFixed(2), '140.00');
    assert.strictEqual(fare.fareRoundingUnit.toString(), '10');
  });

  it('rounds up to a cap without ever going past it (categories 20, 21)', () => {
    // 40.00 + 49.63 = 89.63, whose nearest multiple of 10 is 90 -- exactly the
    // cap. The protection holds because both caps are whole numbers of units:
    // the nearest multiple of a unit to a fare at or below a cap cannot be above
    // that cap.
    const fare = fareFor({
      allocatedLegCost: new Decimal('49.63'),
      acceptedSoloFare: new Decimal('90.00'),
      previousPooledFareCap: new Decimal('90.00'),
    });

    assert.strictEqual(fare.unroundedFare.toFixed(2), '89.63');
    assert.strictEqual(fare.finalFare.toFixed(2), '90.00');
    assert.ok(fare.finalFare.lte(fare.previousPooledFareCap));
    assert.ok(fare.finalFare.lte('90.00'));
  });

  it('never lets the minimum fare override a passenger protection (category 23)', () => {
    // A very short journey: 6.00 of legs plus the base fare is under the 80.00
    // minimum, so the minimum wants to charge 80.00 -- but this passenger was
    // quoted 50.00, and their quote wins.
    const short = fareFor({
      allocatedLegCost: new Decimal('6.00'),
      acceptedSoloFare: new Decimal('50.00'),
      previousPooledFareCap: new Decimal('40.00'),
    });

    assert.strictEqual(short.uncappedPooledFare.toFixed(2), '46.00');
    assert.strictEqual(short.minimumFare.toFixed(2), '80.00');
    assert.strictEqual(short.minimumFareApplied, true, 'the minimum was considered');
    assert.strictEqual(short.finalFare.toFixed(2), '40.00', 'and the protections still win');
    assert.strictEqual(short.noIncreaseCapApplied, true);
    assert.strictEqual(
      short.finalFare.plus(short.soloCapReduction).plus(short.noIncreaseReduction).toFixed(2),
      '80.00',
      'the platform-funded part of the minimum is the difference, and it is recorded',
    );
  });

  it('charges the minimum fare when nothing protects the passenger', () => {
    const fare = fareFor({
      allocatedLegCost: new Decimal('6.00'),
      acceptedSoloFare: new Decimal('180.00'),
    });

    assert.strictEqual(fare.uncappedPooledFare.toFixed(2), '46.00');
    assert.strictEqual(fare.minimumFareApplied, true);
    assert.strictEqual(fare.finalFare.toFixed(2), '80.00', 'the minimum raises the fare');
  });

  it('invents no discount for a passenger who is alone in the car (category 26)', () => {
    // One passenger, one leg, and their share is the whole leg cost -- no
    // sharing, so no reduction from sharing.
    const legCost = computeLegCost({ policy: POLICY, edges: [edge('e1'), edge('e2')], trafficProfile: 'NORMAL' });

    const shares = allocateLegShares({
      totalLegCost: legCost.totalLegCost,
      onboardMemberIds: ['member-a'],
      scale: 2,
    });

    const fare = fareFor({ allocatedLegCost: shares[0].allocatedAmount });

    assert.strictEqual(shares[0].allocatedAmount.toFixed(2), '44.00', 'the whole leg, not half of it');
    assert.strictEqual(fare.uncappedPooledFare.toFixed(2), '84.00', '44.00 of legs plus the 40.00 base fare');
    assert.strictEqual(fare.soloCapApplied, false);
    assert.strictEqual(fare.noIncreaseCapApplied, false);
    assert.strictEqual(fare.soloCapReduction.toFixed(2), '0.00');
    assert.strictEqual(fare.noIncreaseReduction.toFixed(2), '0.00');
  });

  it('refuses to price from a negative amount', () => {
    assert.throws(
      () => fareFor({ acceptedSoloFare: new Decimal('-1.00') }),
      (err) => err instanceof FareCalculationError,
    );
  });
});

// ========================================================================
// Totals and decimal discipline
// ========================================================================

describe('the totals a calculation stores', () => {
  it('adds up the legs and the allocations it was given', () => {
    const allocations = [
      {
        baseFare: new Decimal('40.00'),
        uncappedPooledFare: new Decimal('140.00'),
        minimumFare: new Decimal('80.00'),
        finalFare: new Decimal('140.00'),
        soloCapReduction: new Decimal('0.00'),
        noIncreaseReduction: new Decimal('0.00'),
        fareRoundingAdjustment: new Decimal('0.00'),
      },
      {
        baseFare: new Decimal('40.00'),
        uncappedPooledFare: new Decimal('95.00'),
        minimumFare: new Decimal('80.00'),
        finalFare: new Decimal('80.00'),
        soloCapReduction: new Decimal('15.00'),
        noIncreaseReduction: new Decimal('0.00'),
        fareRoundingAdjustment: new Decimal('0.00'),
      },
    ];

    const totals = totalise({
      legs: [{ totalLegCost: new Decimal('155.00') }],
      allocations,
    });

    assert.strictEqual(totals.totalVariableRouteCost.toFixed(2), '155.00');
    assert.strictEqual(totals.totalPassengerBaseFare.toFixed(2), '80.00');
    assert.strictEqual(totals.totalUncappedPassengerFare.toFixed(2), '235.00');
    assert.strictEqual(totals.totalMinimumFareUplift.toFixed(2), '0.00');
    assert.strictEqual(totals.totalFinalPassengerFare.toFixed(2), '220.00');
    assert.strictEqual(totals.totalSoloCapReduction.toFixed(2), '15.00');
    assert.strictEqual(totals.totalNoIncreaseReduction.toFixed(2), '0.00');
    assert.strictEqual(totals.totalFareRoundingAdjustment.toFixed(2), '0.00');

    // The identity the database enforces, checked here too: what the passengers
    // were charged plus every reduction plus the rounding accounts for the fares
    // and for whatever the minimum fare added on top of them.
    assert.strictEqual(
      totals.totalFinalPassengerFare
        .plus(totals.totalSoloCapReduction)
        .plus(totals.totalNoIncreaseReduction)
        .toFixed(2),
      totals.totalUncappedPassengerFare
        .plus(totals.totalMinimumFareUplift)
        .plus(totals.totalFareRoundingAdjustment)
        .toFixed(2),
    );
  });

  it('adds the per-passenger rounding into one signed pool total', () => {
    // Rounding goes whichever way is nearer, so a pool's total is a net: one
    // passenger's 0.63 given away against another's 4.00 added.
    const totals = totalise({
      legs: [{ totalLegCost: new Decimal('10.00') }],
      allocations: [
        { fareRoundingAdjustment: new Decimal('-0.63') },
        { fareRoundingAdjustment: new Decimal('4.00') },
      ].map((rounding) => ({
        baseFare: new Decimal('0.00'),
        uncappedPooledFare: new Decimal('0.00'),
        minimumFare: new Decimal('0.00'),
        finalFare: new Decimal('0.00'),
        soloCapReduction: new Decimal('0.00'),
        noIncreaseReduction: new Decimal('0.00'),
        ...rounding,
      })),
    });

    assert.strictEqual(totals.totalFareRoundingAdjustment.toFixed(2), '3.37');
  });

  it('records the part of a fare that only the minimum fare produced', () => {
    // 46.00 of pooled fare against an 80.00 minimum: 34.00 of the charge came
    // from the minimum, not from anything the passenger did.
    const allocation = computePassengerFare({
      policy: POLICY,
      allocatedLegCost: new Decimal('6.00'),
      acceptedSoloFare: new Decimal('180.00'),
    });

    const totals = totalise({
      legs: [{ totalLegCost: new Decimal('6.00') }],
      allocations: [allocation],
    });

    assert.strictEqual(totals.totalUncappedPassengerFare.toFixed(2), '46.00');
    assert.strictEqual(totals.totalMinimumFareUplift.toFixed(2), '34.00');
    assert.strictEqual(totals.totalFinalPassengerFare.toFixed(2), '80.00');
    assert.strictEqual(
      totals.totalFinalPassengerFare
        .plus(totals.totalSoloCapReduction)
        .plus(totals.totalNoIncreaseReduction)
        .toFixed(2),
      totals.totalUncappedPassengerFare.plus(totals.totalMinimumFareUplift).toFixed(2),
    );
  });
});

describe('decimal discipline', () => {
  it('refuses a JavaScript number where an amount is required', () => {
    assert.throws(
      () =>
        allocationWithNumber(),
      (err) => err.message.includes('never a JavaScript number'),
    );
  });

  it('carries no binary floating point anywhere in a split', () => {
    const shares = allocateLegShares({
      totalLegCost: new Decimal('0.10'),
      onboardMemberIds: ['member-a', 'member-b', 'member-c'],
      scale: 2,
    });

    // 0.1 + 0.1 + 0.1 is not 0.3 in binary floating point; here it is exactly
    // the leg cost.
    const sum = sumAmounts(shares.map((one) => one.allocatedAmount));
    assert.strictEqual(sum.toFixed(10), '0.1000000000');
    assert.strictEqual(shares.length, 3);
  });

  it('reports the scale it rounds at', () => {
    const shares = allocateLegShares({
      totalLegCost: new Decimal('10.00'),
      onboardMemberIds: ['member-a', 'member-b'],
      scale: 2,
    });

    assert.strictEqual(shares[0].shareRatio.length, SHARE_RATIO_SCALE + 2, '1.00 with ten decimals');
  });
});

const allocationWithNumber = () => {
  computeLegCost({ policy: POLICY, edges: [{ ...edge('e1'), fareWeight: 1.5 }], trafficProfile: 'NORMAL' });
};
