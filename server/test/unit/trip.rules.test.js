import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { POOL_STATUS } from '../../src/services/dispatch.rules.js';
import {
  PASSENGER_NEXT_ACTION,
  PASSENGER_TRIP_STAGE,
  POOL_STATUS_TRANSITIONS,
  TRIP_ACTION,
  TRIP_DECISION,
  TRIP_REJECTION,
  allowedActions,
  canChangePoolStatus,
  decideArrival,
  decideCompletion,
  decideDepart,
  decideDropoff,
  decidePickup,
  decideStart,
  finalDropoffStop,
  firstPickupStop,
  hasDeparted,
  isTripActive,
  memberById,
  nextActionableStop,
  onboardMemberIds,
  orderedStops,
  passengerNextAction,
  passengerTripStage,
  planIsProcessable,
  stopActionIsOpen,
} from '../../src/services/trip.rules.js';

/**
 * The trip's rules, with no database and no clock.
 *
 * The plans below are the shapes a pool can actually have, which is what makes
 * the assertions worth anything: two passengers collected at the same corner are
 * two stops at the same service point, and the order they are numbered in is the
 * order they are driven in.
 */

const stop = (sequence, stopType, poolMemberId, status = 'PENDING', servicePointId = 'point') => ({
  id: `stop-${sequence}`,
  sequence,
  stopType,
  poolMemberId,
  status,
  servicePointId,
});

const member = (id, status = 'ASSIGNED', requestStatus = 'MATCHED') => ({
  id,
  status,
  rideRequestId: `request-${id}`,
  requestStatus,
});

/** Two passengers, collected at the same corner, delivered to the same place. */
const SHARED_PICKUP_PLAN = () => [
  stop(1, 'PICKUP', 'member-a', 'PENDING', 'banani'),
  stop(2, 'PICKUP', 'member-b', 'PENDING', 'banani'),
  stop(3, 'DROPOFF', 'member-a', 'PENDING', 'mohakhali'),
  stop(4, 'DROPOFF', 'member-b', 'PENDING', 'mohakhali'),
];

/** Two passengers, one collected before the other, with separate corners. */
const SEQUENTIAL_PLAN = () => [
  stop(1, 'PICKUP', 'member-a', 'PENDING', 'banani'),
  stop(2, 'DROPOFF', 'member-a', 'PENDING', 'mohakhali'),
  stop(3, 'PICKUP', 'member-b', 'PENDING', 'gulshan'),
  stop(4, 'DROPOFF', 'member-b', 'PENDING', 'motijheel'),
];

const FARE = Object.freeze({ id: 'calculation', status: 'FINALIZED', finalizedAt: new Date() });

const context = ({ status = POOL_STATUS.FORMING, stops, members, fare = FARE } = {}) => ({
  pool: { status },
  stops: stops ?? SHARED_PICKUP_PLAN(),
  members: members ?? [member('member-a'), member('member-b')],
  fare,
});

const expectDecision = (decision, expected, reason = null) => {
  assert.strictEqual(decision.decision, expected);
  if (reason) assert.strictEqual(decision.reason, reason, expected);
};

describe('the pool status machine', () => {
  it('has exactly the five statuses a trip passes through, and no way back', () => {
    assert.deepStrictEqual(Object.keys(POOL_STATUS_TRANSITIONS), [
      'FORMING',
      'DRIVER_EN_ROUTE',
      'ARRIVED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
    ]);

    assert.strictEqual(canChangePoolStatus('FORMING', 'DRIVER_EN_ROUTE'), true);
    assert.strictEqual(canChangePoolStatus('DRIVER_EN_ROUTE', 'ARRIVED'), true);
    assert.strictEqual(canChangePoolStatus('ARRIVED', 'IN_PROGRESS'), true);
    assert.strictEqual(canChangePoolStatus('IN_PROGRESS', 'COMPLETED'), true);

    // No skipping, no going back, and nothing out of a finished pool.
    for (const [from, to] of [
      ['FORMING', 'ARRIVED'],
      ['FORMING', 'IN_PROGRESS'],
      ['FORMING', 'COMPLETED'],
      ['DRIVER_EN_ROUTE', 'IN_PROGRESS'],
      ['ARRIVED', 'COMPLETED'],
      ['IN_PROGRESS', 'ARRIVED'],
      ['COMPLETED', 'IN_PROGRESS'],
      ['CANCELLED', 'FORMING'],
    ]) {
      assert.strictEqual(canChangePoolStatus(from, to), false, `${from}->${to}`);
    }
  });

  it('recognises what has departed and what is still being driven', () => {
    assert.strictEqual(hasDeparted('FORMING'), false);
    assert.strictEqual(hasDeparted('CANCELLED'), false);
    for (const status of ['DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED']) {
      assert.strictEqual(hasDeparted(status), true, status);
    }

    // A pool with a trip *in* it, as opposed to one that has had a trip: a
    // completed pool is over, and nothing about it may move any more.
    assert.strictEqual(isTripActive('DRIVER_EN_ROUTE'), true);
    assert.strictEqual(isTripActive('ARRIVED'), true);
    assert.strictEqual(isTripActive('IN_PROGRESS'), true);
    assert.strictEqual(isTripActive('FORMING'), false);
    assert.strictEqual(isTripActive('COMPLETED'), false);
    assert.strictEqual(isTripActive('CANCELLED'), false);
  });
});

describe('reading the plan', () => {
  it('orders the plan by sequence, whatever order the rows arrive in (category 2)', () => {
    const shuffled = [stop(3, 'DROPOFF', 'member-a', 'PENDING'), stop(1, 'PICKUP', 'member-a'), stop(2, 'PICKUP', 'member-b')];

    assert.deepStrictEqual(
      orderedStops(shuffled).map((candidate) => candidate.sequence),
      [1, 2, 3],
    );
  });

  it('names the next actionable stop as the lowest not-completed one (category 2)', () => {
    const stops = SHARED_PICKUP_PLAN();
    assert.strictEqual(nextActionableStop(stops).id, 'stop-1');

    stops[0].status = 'ARRIVED';
    assert.strictEqual(nextActionableStop(stops).id, 'stop-1', 'a reached stop is still actionable');

    stops[0].status = 'COMPLETED';
    assert.strictEqual(nextActionableStop(stops).id, 'stop-2', 'the corner is still open for the second passenger');

    stops[1].status = 'COMPLETED';
    assert.strictEqual(nextActionableStop(stops).id, 'stop-3');

    for (const candidate of stops) candidate.status = 'COMPLETED';
    assert.strictEqual(nextActionableStop(stops), null);
  });

  it('finds the first pickup and the final drop-off', () => {
    const stops = SHARED_PICKUP_PLAN();
    assert.strictEqual(firstPickupStop(stops).id, 'stop-1');
    assert.strictEqual(finalDropoffStop(stops).id, 'stop-4');

    assert.strictEqual(finalDropoffStop([stop(1, 'PICKUP', 'member-a')]), null);
  });

  it('finds a member by id, and answers null for a stranger', () => {
    const members = [member('member-a')];
    assert.strictEqual(memberById(members, 'member-a').id, 'member-a');
    assert.strictEqual(memberById(members, 'member-z'), null);
  });

  it('says who is physically in the vehicle (categories 11, 13)', () => {
    assert.deepStrictEqual(
      onboardMemberIds([member('member-a', 'ASSIGNED'), member('member-b', 'PICKED_UP')]),
      ['member-b'],
    );
    assert.deepStrictEqual(
      onboardMemberIds([member('member-a', 'DROPPED_OFF'), member('member-b', 'PICKED_UP')]),
      ['member-b'],
    );
    assert.deepStrictEqual(onboardMemberIds([member('member-a', 'ASSIGNED')]), []);
  });

  it('refuses a plan that cannot be driven at all', () => {
    assert.strictEqual(planIsProcessable({ stops: SHARED_PICKUP_PLAN(), members: [member('member-a'), member('member-b')] }), true);

    // No members, or nothing to drive.
    assert.strictEqual(planIsProcessable({ stops: SHARED_PICKUP_PLAN(), members: [] }), false);
    assert.strictEqual(planIsProcessable({ stops: [], members: [member('member-a')] }), false);
    assert.strictEqual(planIsProcessable({ stops: [stop(1, 'PICKUP', 'member-a')], members: [member('member-a')] }), false);

    // A gap in the order the driver follows.
    assert.strictEqual(
      planIsProcessable({
        stops: [stop(1, 'PICKUP', 'member-a'), stop(3, 'DROPOFF', 'member-a')],
        members: [member('member-a')],
      }),
      false,
    );

    // A member with only one of their two stops.
    assert.strictEqual(
      planIsProcessable({
        stops: [stop(1, 'PICKUP', 'member-a'), stop(2, 'PICKUP', 'member-b'), stop(3, 'DROPOFF', 'member-b')],
        members: [member('member-a'), member('member-b')],
      }),
      false,
    );

    // A drop-off before its own pickup.
    assert.strictEqual(
      planIsProcessable({
        stops: [stop(1, 'DROPOFF', 'member-a'), stop(2, 'PICKUP', 'member-a')],
        members: [member('member-a')],
      }),
      false,
    );
  });

  it('knows whether a stop still has its action open', () => {
    const stops = SHARED_PICKUP_PLAN();

    assert.strictEqual(stopActionIsOpen(stops[0], [member('member-a', 'ASSIGNED')]), true);
    assert.strictEqual(stopActionIsOpen(stops[0], [member('member-a', 'PICKED_UP')]), false);
    assert.strictEqual(stopActionIsOpen(stops[2], [member('member-a', 'PICKED_UP')]), true);
    assert.strictEqual(stopActionIsOpen(stops[2], [member('member-a', 'DROPPED_OFF')]), false);
  });
});

describe('departure', () => {
  it('applies to a forming pool with a drivable plan', () => {
    expectDecision(decideDepart(context()), TRIP_DECISION.APPLY);
  });

  it('repeats once the pool has departed, whichever state it moved on to', () => {
    for (const status of ['DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED']) {
      expectDecision(decideDepart(context({ status })), TRIP_DECISION.REPEAT);
    }
  });

  it('refuses a pool that was cancelled', () => {
    expectDecision(
      decideDepart(context({ status: 'CANCELLED' })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.POOL_NOT_FORMING,
    );
  });

  it('refuses a pool with nobody to drive', () => {
    expectDecision(
      decideDepart(context({ members: [] })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.NO_MEMBERS,
    );
  });

  it('refuses a plan that cannot be driven', () => {
    expectDecision(
      decideDepart(context({ stops: [stop(1, 'PICKUP', 'member-a')] })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.INCOMPLETE_PLAN,
    );
  });

  it('refuses to depart a pool whose stops have already been touched', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'ARRIVED';

    expectDecision(
      decideDepart(context({ stops })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.STOPS_ALREADY_STARTED,
    );
  });
});

describe('arriving at a stop', () => {
  it('applies to the next actionable stop once the pool has departed', () => {
    const stops = SHARED_PICKUP_PLAN();
    expectDecision(
      decideArrival({ pool: { status: 'DRIVER_EN_ROUTE' }, stop: stops[0], stops }),
      TRIP_DECISION.APPLY,
    );
  });

  it('refuses a stop before the pool has departed', () => {
    const stops = SHARED_PICKUP_PLAN();
    expectDecision(
      decideArrival({ pool: { status: 'FORMING' }, stop: stops[0], stops }),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.POOL_NOT_DEPARTED,
    );
  });

  it('refuses a later stop while an earlier one is still ahead (category 2)', () => {
    const stops = SHARED_PICKUP_PLAN();
    expectDecision(
      decideArrival({ pool: { status: 'DRIVER_EN_ROUTE' }, stop: stops[1], stops }),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.STOP_NOT_NEXT,
    );
  });

  it('repeats for a stop that has been reached or finished', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'ARRIVED';
    expectDecision(
      decideArrival({ pool: { status: 'ARRIVED' }, stop: stops[0], stops }),
      TRIP_DECISION.REPEAT,
    );

    stops[0].status = 'COMPLETED';
    expectDecision(
      decideArrival({ pool: { status: 'ARRIVED' }, stop: stops[0], stops }),
      TRIP_DECISION.REPEAT,
    );
  });

  it('refuses a stop that is not in this pool', () => {
    const stops = SHARED_PICKUP_PLAN();
    expectDecision(
      decideArrival({ pool: { status: 'DRIVER_EN_ROUTE' }, stop: stop(9, 'PICKUP', 'member-z'), stops }),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.STOP_NOT_NEXT,
    );
  });

  it('lets the driver reach the second pickup at a corner both passengers share', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'COMPLETED';

    expectDecision(
      decideArrival({ pool: { status: 'ARRIVED' }, stop: stops[1], stops }),
      TRIP_DECISION.APPLY,
    );
  });
});

describe('collecting a passenger', () => {
  const pickupContext = ({ stops = SHARED_PICKUP_PLAN(), members = [member('member-a'), member('member-b')] } = {}) => ({
    pool: { status: 'ARRIVED' },
    stops,
    members,
    stop: stops[0],
    member: members[0],
  });

  it('applies at a reached pickup stop', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'ARRIVED';
    expectDecision(decidePickup(pickupContext({ stops })), TRIP_DECISION.APPLY);
  });

  it('refuses a pickup at a stop that has not been reached (category 4)', () => {
    expectDecision(
      decidePickup(pickupContext()),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.STOP_NOT_ARRIVED,
    );
  });

  it('refuses a pickup before the pool has reached its first stop', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'ARRIVED';

    expectDecision(
      decidePickup({ ...pickupContext({ stops }), pool: { status: 'DRIVER_EN_ROUTE' } }),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.POOL_NOT_ARRIVED,
    );
  });

  it('refuses a passenger at a stop that belongs to somebody else', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'ARRIVED';
    const members = [member('member-a'), member('member-b')];

    expectDecision(
      decidePickup({ ...pickupContext({ stops, members }), member: members[1] }),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.MEMBER_NOT_ON_STOP,
    );
  });

  it('refuses a passenger who is not in this pool', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'ARRIVED';

    expectDecision(
      decidePickup({ ...pickupContext({ stops }), member: member('member-z') }),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.MEMBER_NOT_ON_STOP,
    );
  });

  it('refuses to collect anybody at a drop-off stop', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'COMPLETED';
    stops[1].status = 'COMPLETED';
    stops[2].status = 'ARRIVED';

    expectDecision(
      decidePickup({ ...pickupContext({ stops }), stop: stops[2], member: member('member-a', 'PICKED_UP') }),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.WRONG_STOP_TYPE,
    );
  });

  it('refuses a second stop at a corner before the first one is served (category 6)', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[1].status = 'ARRIVED';
    const members = [member('member-a'), member('member-b')];

    expectDecision(
      decidePickup({ ...pickupContext({ stops, members }), stop: stops[1], member: members[1] }),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.STOP_NOT_NEXT,
    );
  });

  it('repeats for a passenger who is already aboard (category 17)', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'COMPLETED';
    const members = [member('member-a', 'PICKED_UP'), member('member-b')];

    expectDecision(
      decidePickup({ ...pickupContext({ stops, members }), member: members[0] }),
      TRIP_DECISION.REPEAT,
    );

    const delivered = [member('member-a', 'DROPPED_OFF'), member('member-b')];
    expectDecision(
      decidePickup({ ...pickupContext({ stops, members: delivered }), member: delivered[0] }),
      TRIP_DECISION.REPEAT,
    );
  });

  it('refuses a passenger whose ride is not waiting to be collected', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'ARRIVED';
    const members = [member('member-a', 'ASSIGNED', 'COMPLETED'), member('member-b')];

    expectDecision(
      decidePickup({ ...pickupContext({ stops, members }), member: members[0] }),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.REQUEST_NOT_MATCHED,
    );
  });
});

describe('starting the trip', () => {
  it('applies once a passenger is aboard and the corner is cleared (categories 7, 8)', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'COMPLETED';
    stops[1].status = 'COMPLETED';
    const members = [member('member-a', 'PICKED_UP'), member('member-b', 'PICKED_UP')];

    expectDecision(decideStart(context({ status: 'ARRIVED', stops, members })), TRIP_DECISION.APPLY);
  });

  it('refuses a trip with nobody in the car (category 7)', () => {
    const stops = SEQUENTIAL_PLAN();
    expectDecision(
      decideStart(context({ status: 'ARRIVED', stops })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.NO_MEMBER_PICKED_UP,
    );
  });

  it('refuses to start while a pickup at the current stop is still open (category 7)', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'COMPLETED';
    const members = [member('member-a', 'PICKED_UP'), member('member-b')];

    expectDecision(
      decideStart(context({ status: 'ARRIVED', stops, members })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.PICKUP_ACTION_OPEN,
    );
  });

  it('starts with a passenger still to be collected further along (category 9)', () => {
    const stops = SEQUENTIAL_PLAN();
    stops[0].status = 'COMPLETED';
    const members = [member('member-a', 'PICKED_UP'), member('member-b', 'ASSIGNED')];

    expectDecision(decideStart(context({ status: 'ARRIVED', stops, members })), TRIP_DECISION.APPLY);
  });

  it('refuses to start before the driver has reached the first pickup', () => {
    const stops = SEQUENTIAL_PLAN();
    stops[0].status = 'COMPLETED';
    const members = [member('member-a', 'PICKED_UP'), member('member-b', 'ASSIGNED')];

    expectDecision(
      decideStart(context({ status: 'DRIVER_EN_ROUTE', stops, members })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.POOL_NOT_ARRIVED,
    );
  });

  it('refuses to start without a settled fare', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'COMPLETED';
    stops[1].status = 'COMPLETED';
    const members = [member('member-a', 'PICKED_UP'), member('member-b', 'PICKED_UP')];

    for (const fare of [null, { id: 'calculation', status: 'CURRENT', finalizedAt: null }]) {
      expectDecision(
        decideStart(context({ status: 'ARRIVED', stops, members, fare })),
        TRIP_DECISION.REFUSE,
        TRIP_REJECTION.FARE_NOT_FINALIZED,
      );
    }
  });

  it('repeats once the trip is under way or over', () => {
    for (const status of ['IN_PROGRESS', 'COMPLETED']) {
      expectDecision(decideStart(context({ status })), TRIP_DECISION.REPEAT);
    }
  });
});

describe('delivering a passenger', () => {
  const dropoffContext = ({ poolStatus = 'IN_PROGRESS', stops, members } = {}) => {
    const plan = stops ?? SHARED_PICKUP_PLAN();
    // Both passengers are aboard and their rides are under way: a passenger who
    // can be delivered is one whose ride has started.
    const crew = members ?? [
      member('member-a', 'PICKED_UP', 'IN_PROGRESS'),
      member('member-b', 'PICKED_UP', 'IN_PROGRESS'),
    ];

    return {
      pool: { status: poolStatus },
      stops: plan,
      members: crew,
      stop: plan[2],
      member: crew[0],
    };
  };

  const arrivedAtDropoff = () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'COMPLETED';
    stops[1].status = 'COMPLETED';
    stops[2].status = 'ARRIVED';
    return stops;
  };

  it('applies to a passenger who is aboard, at their own reached stop (category 12)', () => {
    const stops = arrivedAtDropoff();
    expectDecision(decideDropoff(dropoffContext({ stops })), TRIP_DECISION.APPLY);
  });

  it('refuses a delivery before the passenger was collected (category 11)', () => {
    const stops = arrivedAtDropoff();
    const members = [member('member-a', 'ASSIGNED', 'MATCHED'), member('member-b', 'PICKED_UP', 'IN_PROGRESS')];

    expectDecision(
      decideDropoff(dropoffContext({ stops, members })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.MEMBER_NOT_PICKED_UP,
    );
  });

  it('refuses a delivery during a trip that has not started', () => {
    const stops = arrivedAtDropoff();
    expectDecision(
      decideDropoff(dropoffContext({ poolStatus: 'ARRIVED', stops })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.POOL_NOT_IN_PROGRESS,
    );
  });

  it('refuses a delivery at a stop that has not been reached', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'COMPLETED';
    stops[1].status = 'COMPLETED';

    expectDecision(
      decideDropoff(dropoffContext({ stops })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.STOP_NOT_ARRIVED,
    );
  });

  it('refuses a delivery out of order', () => {
    const stops = arrivedAtDropoff();
    stops[3].status = 'ARRIVED';
    const members = [
      member('member-a', 'PICKED_UP', 'IN_PROGRESS'),
      member('member-b', 'PICKED_UP', 'IN_PROGRESS'),
    ];

    // The second drop-off, while the first is still standing open: the passenger
    // is the right one for that stop, and it is still not their turn.
    expectDecision(
      decideDropoff({ ...dropoffContext({ stops, members }), stop: stops[3], member: members[1] }),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.STOP_NOT_NEXT,
    );
  });

  it('refuses a passenger at a stop that belongs to somebody else', () => {
    const stops = arrivedAtDropoff();
    const members = [member('member-a', 'PICKED_UP'), member('member-b', 'PICKED_UP', 'IN_PROGRESS')];

    expectDecision(
      decideDropoff({ ...dropoffContext({ stops, members }), member: members[1] }),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.MEMBER_NOT_ON_STOP,
    );
  });

  it('refuses to deliver at a pickup stop', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'ARRIVED';
    const members = [member('member-a', 'PICKED_UP'), member('member-b', 'PICKED_UP')];

    expectDecision(
      decideDropoff({ ...dropoffContext({ stops, members }), stop: stops[0] }),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.WRONG_STOP_TYPE,
    );
  });

  it('refuses a ride that is not under way', () => {
    const stops = arrivedAtDropoff();
    const members = [member('member-a', 'PICKED_UP', 'MATCHED'), member('member-b', 'PICKED_UP', 'IN_PROGRESS')];

    expectDecision(
      decideDropoff(dropoffContext({ stops, members })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.REQUEST_NOT_IN_PROGRESS,
    );
  });

  it('repeats for a passenger who has already been delivered (category 17)', () => {
    const stops = SHARED_PICKUP_PLAN();
    stops[0].status = 'COMPLETED';
    stops[1].status = 'COMPLETED';
    stops[2].status = 'COMPLETED';
    const members = [member('member-a', 'DROPPED_OFF', 'COMPLETED'), member('member-b', 'PICKED_UP', 'IN_PROGRESS')];

    expectDecision(decideDropoff(dropoffContext({ stops, members })), TRIP_DECISION.REPEAT);
  });
});

describe('completing the trip', () => {
  const finishedPlan = () => SHARED_PICKUP_PLAN().map((candidate) => ({ ...candidate, status: 'COMPLETED' }));
  const deliveredMembers = () => [
    member('member-a', 'DROPPED_OFF', 'COMPLETED'),
    member('member-b', 'DROPPED_OFF', 'COMPLETED'),
  ];

  it('applies once every stop is served and every passenger is out', () => {
    expectDecision(
      decideCompletion(context({ status: 'IN_PROGRESS', stops: finishedPlan(), members: deliveredMembers() })),
      TRIP_DECISION.APPLY,
    );
  });

  it('refuses while a stop is unfinished (category 14)', () => {
    const stops = finishedPlan();
    stops[3].status = 'ARRIVED';

    expectDecision(
      decideCompletion(context({ status: 'IN_PROGRESS', stops, members: deliveredMembers() })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.STOPS_UNFINISHED,
    );
  });

  it('refuses while a passenger is still in the vehicle (category 15)', () => {
    const members = [member('member-a', 'DROPPED_OFF', 'COMPLETED'), member('member-b', 'PICKED_UP', 'IN_PROGRESS')];

    expectDecision(
      decideCompletion(context({ status: 'IN_PROGRESS', stops: finishedPlan(), members })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.MEMBERS_ONBOARD,
    );
  });

  it('refuses while a passenger has not been delivered at all', () => {
    const members = [member('member-a', 'DROPPED_OFF', 'COMPLETED'), member('member-b', 'ASSIGNED', 'MATCHED')];

    expectDecision(
      decideCompletion(context({ status: 'IN_PROGRESS', stops: finishedPlan(), members })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.MEMBERS_ONBOARD,
    );
  });

  it('refuses while a ride is still open', () => {
    const members = [member('member-a', 'DROPPED_OFF', 'COMPLETED'), member('member-b', 'DROPPED_OFF', 'IN_PROGRESS')];

    expectDecision(
      decideCompletion(context({ status: 'IN_PROGRESS', stops: finishedPlan(), members })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.REQUESTS_UNFINISHED,
    );
  });

  it('ignores a member whose ride was called off, because they are not in the pool', () => {
    const members = [...deliveredMembers(), member('member-c', 'NO_SHOW', 'MATCHED')];

    expectDecision(
      decideCompletion(context({ status: 'IN_PROGRESS', stops: finishedPlan(), members })),
      TRIP_DECISION.APPLY,
    );
  });

  it('refuses to complete a trip that has not started', () => {
    expectDecision(
      decideCompletion(context({ status: 'ARRIVED', stops: finishedPlan(), members: deliveredMembers() })),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.POOL_NOT_IN_PROGRESS,
    );
  });

  it('refuses without a settled fare', () => {
    expectDecision(
      decideCompletion(
        context({
          status: 'IN_PROGRESS',
          stops: finishedPlan(),
          members: deliveredMembers(),
          fare: null,
        }),
      ),
      TRIP_DECISION.REFUSE,
      TRIP_REJECTION.FARE_NOT_FINALIZED,
    );
  });

  it('repeats for a pool that is already complete (categories 16, 17)', () => {
    expectDecision(
      decideCompletion(context({ status: 'COMPLETED', stops: finishedPlan(), members: deliveredMembers() })),
      TRIP_DECISION.REPEAT,
    );
  });
});

describe('what a driver is told they can do', () => {
  const withStatus = (stops, sequence, status) => {
    const plan = stops.map((candidate) => ({ ...candidate }));
    plan[sequence - 1].status = status;
    return plan;
  };

  it('offers departure for a forming pool, and nothing else', () => {
    assert.deepStrictEqual(allowedActions(context()), [TRIP_ACTION.DEPART]);

    assert.deepStrictEqual(
      allowedActions(context({ members: [] })),
      [],
      'a pool with no passengers cannot even depart',
    );
  });

  it('offers reaching the next stop while the driver is on their way', () => {
    const stops = SHARED_PICKUP_PLAN();
    assert.deepStrictEqual(
      allowedActions(context({ status: 'DRIVER_EN_ROUTE', stops })),
      [TRIP_ACTION.ARRIVE_AT_STOP],
    );
  });

  it('offers only the pickup at a reached pickup stop (categories 3, 4)', () => {
    const stops = withStatus(SHARED_PICKUP_PLAN(), 1, 'ARRIVED');

    assert.deepStrictEqual(allowedActions(context({ status: 'ARRIVED', stops })), [
      TRIP_ACTION.PICKUP_PASSENGER,
    ]);
  });

  it('offers the next pickup at a corner two passengers share, and only once it is reached', () => {
    let stops = withStatus(SHARED_PICKUP_PLAN(), 1, 'COMPLETED');
    const members = [member('member-a', 'PICKED_UP'), member('member-b')];

    assert.deepStrictEqual(allowedActions(context({ status: 'ARRIVED', stops, members })), [
      TRIP_ACTION.ARRIVE_AT_STOP,
    ]);

    stops = withStatus(stops, 2, 'ARRIVED');
    assert.deepStrictEqual(allowedActions(context({ status: 'ARRIVED', stops, members })), [
      TRIP_ACTION.PICKUP_PASSENGER,
    ]);
  });

  it('offers starting the trip once the corner is cleared (category 8)', () => {
    let stops = withStatus(SHARED_PICKUP_PLAN(), 1, 'COMPLETED');
    stops = withStatus(stops, 2, 'COMPLETED');
    const members = [member('member-a', 'PICKED_UP'), member('member-b', 'PICKED_UP')];

    assert.deepStrictEqual(allowedActions(context({ status: 'ARRIVED', stops, members })), [
      TRIP_ACTION.ARRIVE_AT_STOP,
      TRIP_ACTION.START_TRIP,
    ]);
  });

  it('offers the delivery at a reached drop-off during a trip (categories 12, 13)', () => {
    let stops = withStatus(SHARED_PICKUP_PLAN(), 1, 'COMPLETED');
    stops = withStatus(stops, 2, 'COMPLETED');
    stops = withStatus(stops, 3, 'ARRIVED');
    const members = [
      member('member-a', 'PICKED_UP', 'IN_PROGRESS'),
      member('member-b', 'PICKED_UP', 'IN_PROGRESS'),
    ];

    assert.deepStrictEqual(allowedActions(context({ status: 'IN_PROGRESS', stops, members })), [
      TRIP_ACTION.DROPOFF_PASSENGER,
    ]);
  });

  it('offers completion only when everything really is finished (category 16)', () => {
    const stops = SHARED_PICKUP_PLAN().map((candidate) => ({ ...candidate, status: 'COMPLETED' }));
    const members = [
      member('member-a', 'DROPPED_OFF', 'COMPLETED'),
      member('member-b', 'DROPPED_OFF', 'COMPLETED'),
    ];

    assert.deepStrictEqual(allowedActions(context({ status: 'IN_PROGRESS', stops, members })), [
      TRIP_ACTION.COMPLETE_TRIP,
    ]);
    assert.deepStrictEqual(allowedActions(context({ status: 'COMPLETED', stops, members })), []);
  });

  it('offers nothing at all once the pool is cancelled', () => {
    assert.deepStrictEqual(allowedActions(context({ status: 'CANCELLED' })), []);
  });

  it('never offers an action the operation itself would refuse (categories 3, 4, 7, 14, 15)', () => {
    // Every action offered must be one whose decision applies, for a spread of
    // real states -- otherwise a client would be handed a button that 409s.
    const states = [
      context({ status: 'FORMING' }),
      context({ status: 'DRIVER_EN_ROUTE' }),
      context({ status: 'ARRIVED', stops: withStatus(SHARED_PICKUP_PLAN(), 1, 'ARRIVED') }),
      context({
        status: 'ARRIVED',
        stops: withStatus(SHARED_PICKUP_PLAN(), 1, 'COMPLETED'),
        members: [member('member-a', 'PICKED_UP'), member('member-b')],
      }),
      context({
        status: 'IN_PROGRESS',
        stops: withStatus(SHARED_PICKUP_PLAN(), 4, 'ARRIVED'),
        members: [member('member-a', 'DROPPED_OFF', 'COMPLETED'), member('member-b', 'PICKED_UP', 'IN_PROGRESS')],
      }),
      context({ status: 'COMPLETED' }),
    ];

    for (const state of states) {
      const actions = allowedActions(state);
      const next = nextActionableStop(state.stops);

      for (const action of actions) {
        switch (action) {
          case TRIP_ACTION.DEPART:
            expectDecision(decideDepart(state), TRIP_DECISION.APPLY);
            break;
          case TRIP_ACTION.ARRIVE_AT_STOP:
            expectDecision(decideArrival({ ...state, stop: next }), TRIP_DECISION.APPLY);
            break;
          case TRIP_ACTION.PICKUP_PASSENGER:
            expectDecision(
              decidePickup({ ...state, stop: next, member: memberById(state.members, next.poolMemberId) }),
              TRIP_DECISION.APPLY,
            );
            break;
          case TRIP_ACTION.DROPOFF_PASSENGER:
            expectDecision(
              decideDropoff({ ...state, stop: next, member: memberById(state.members, next.poolMemberId) }),
              TRIP_DECISION.APPLY,
            );
            break;
          case TRIP_ACTION.START_TRIP:
            expectDecision(decideStart(state), TRIP_DECISION.APPLY);
            break;
          case TRIP_ACTION.COMPLETE_TRIP:
            expectDecision(decideCompletion(state), TRIP_DECISION.APPLY);
            break;
          default:
            assert.fail(`unknown action ${action}`);
        }
      }
    }
  });
});

describe('the stage a passenger is shown', () => {
  it('walks the six stages in order, from the facts alone (category 19)', () => {
    const departed = new Date('2026-09-24T10:00:00Z');
    const arrived = new Date('2026-09-24T10:05:00Z');
    const pickedUp = new Date('2026-09-24T10:06:00Z');
    const droppedOff = new Date('2026-09-24T10:30:00Z');

    assert.strictEqual(passengerTripStage({ requestStatus: 'MATCHED' }), PASSENGER_TRIP_STAGE.DRIVER_ASSIGNED);
    assert.strictEqual(
      passengerTripStage({ requestStatus: 'MATCHED', departedAt: departed }),
      PASSENGER_TRIP_STAGE.DRIVER_EN_ROUTE,
    );
    assert.strictEqual(
      passengerTripStage({ requestStatus: 'MATCHED', departedAt: departed, arrivedAt: arrived }),
      PASSENGER_TRIP_STAGE.DRIVER_ARRIVED,
    );
    assert.strictEqual(
      passengerTripStage({
        requestStatus: 'MATCHED',
        departedAt: departed,
        arrivedAt: arrived,
        pickedUpAt: pickedUp,
      }),
      PASSENGER_TRIP_STAGE.PICKED_UP,
    );
    assert.strictEqual(
      passengerTripStage({
        requestStatus: 'IN_PROGRESS',
        departedAt: departed,
        arrivedAt: arrived,
        pickedUpAt: pickedUp,
      }),
      PASSENGER_TRIP_STAGE.IN_PROGRESS,
    );
    assert.strictEqual(
      passengerTripStage({
        requestStatus: 'COMPLETED',
        departedAt: departed,
        arrivedAt: arrived,
        pickedUpAt: pickedUp,
        droppedOffAt: droppedOff,
      }),
      PASSENGER_TRIP_STAGE.RIDE_COMPLETED,
    );
  });

  it('reports a completed ride as completed even if a delivery time were lost', () => {
    assert.strictEqual(
      passengerTripStage({ requestStatus: 'COMPLETED', droppedOffAt: null }),
      PASSENGER_TRIP_STAGE.RIDE_COMPLETED,
    );
  });

  it('never reports a later stage for an earlier fact', () => {
    // A passenger who is still waiting for the car cannot be shown as aboard.
    assert.strictEqual(
      passengerTripStage({ requestStatus: 'MATCHED', pickedUpAt: null, arrivedAt: null }),
      PASSENGER_TRIP_STAGE.DRIVER_ASSIGNED,
    );
  });
});

describe('the one thing a passenger is told to do next', () => {
  it('maps every stage to an action, and every stage of the journey to its own', () => {
    const expected = {
      [PASSENGER_TRIP_STAGE.DRIVER_ASSIGNED]: PASSENGER_NEXT_ACTION.WAIT_FOR_DRIVER,
      [PASSENGER_TRIP_STAGE.DRIVER_EN_ROUTE]: PASSENGER_NEXT_ACTION.WATCH_DRIVER,
      [PASSENGER_TRIP_STAGE.DRIVER_ARRIVED]: PASSENGER_NEXT_ACTION.BOARD_VEHICLE,
      [PASSENGER_TRIP_STAGE.PICKED_UP]: PASSENGER_NEXT_ACTION.IN_RIDE,
      [PASSENGER_TRIP_STAGE.IN_PROGRESS]: PASSENGER_NEXT_ACTION.IN_RIDE,
      [PASSENGER_TRIP_STAGE.RIDE_COMPLETED]: PASSENGER_NEXT_ACTION.RIDE_FINISHED,
    };

    // Every stage is mapped. A stage with no action would leave a client with a
    // blank screen at one point of every journey.
    assert.deepStrictEqual(
      Object.keys(expected).sort(),
      Object.values(PASSENGER_TRIP_STAGE).sort(),
    );

    for (const [stage, action] of Object.entries(expected)) {
      assert.strictEqual(passengerNextAction(stage), action, stage);
    }
  });

  it('walks the whole journey as the stage does, in order', () => {
    const journey = [
      [{ requestStatus: 'MATCHED' }, PASSENGER_NEXT_ACTION.WAIT_FOR_DRIVER],
      [
        { requestStatus: 'MATCHED', departedAt: new Date() },
        PASSENGER_NEXT_ACTION.WATCH_DRIVER,
      ],
      [
        { requestStatus: 'MATCHED', departedAt: new Date(), arrivedAt: new Date() },
        PASSENGER_NEXT_ACTION.BOARD_VEHICLE,
      ],
      [
        {
          requestStatus: 'MATCHED',
          departedAt: new Date(),
          arrivedAt: new Date(),
          pickedUpAt: new Date(),
        },
        PASSENGER_NEXT_ACTION.IN_RIDE,
      ],
      [{ requestStatus: 'IN_PROGRESS', pickedUpAt: new Date() }, PASSENGER_NEXT_ACTION.IN_RIDE],
      [
        { requestStatus: 'COMPLETED', pickedUpAt: new Date(), droppedOffAt: new Date() },
        PASSENGER_NEXT_ACTION.RIDE_FINISHED,
      ],
    ];

    for (const [facts, action] of journey) {
      assert.strictEqual(passengerNextAction(passengerTripStage(facts)), action);
    }
  });

  it('is boring rather than inventing a button for a stage it does not know', () => {
    // Unreachable through the API, so the honest answer is "keep waiting" -- never
    // an action that would do nothing when pressed.
    assert.strictEqual(passengerNextAction('SOMETHING_ELSE'), PASSENGER_NEXT_ACTION.WAIT_FOR_DRIVER);
    assert.strictEqual(passengerNextAction(undefined), PASSENGER_NEXT_ACTION.WAIT_FOR_DRIVER);
    assert.strictEqual(passengerNextAction(null), PASSENGER_NEXT_ACTION.WAIT_FOR_DRIVER);
  });
});

