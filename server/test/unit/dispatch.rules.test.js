import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTIVE_POOL_STATUSES,
  AVAILABILITY_TRANSITIONS,
  bestCandidate,
  buildProposalSnapshot,
  candidateScore,
  canChangeAvailability,
  canGoOffline,
  canGoOnline,
  canSetCurrentServicePoint,
  compareCandidates,
  DEFAULT_REJECTION_REASON,
  DISPATCHABLE_AVAILABILITY,
  DROPOFF_SEQUENCE,
  DRIVER_AVAILABILITIES,
  DRIVER_AVAILABILITY,
  IMPLEMENTED_AVAILABILITY_TRANSITIONS,
  IMPLEMENTED_OFFER_TYPE,
  IMPLEMENTED_POOL_STATUS,
  isActivePoolStatus,
  isDriverAvailability,
  isImplementedAvailabilityChange,
  isOfferExpired,
  isOfferStatus,
  isPendingOffer,
  isRejectionReason,
  isTerminalOfferStatus,
  OFFER_STATUS,
  OFFER_STATUSES,
  OFFER_TYPE,
  PICKUP_SEQUENCE,
  POOL_ACTOR_TYPE,
  POOL_EVENT_TYPE,
  POOL_MEMBER_STATUS,
  POOL_STATUS,
  POOL_STATUSES,
  POOL_STOP_STATUS,
  POOL_STOP_TYPE,
  REJECTION_REASONS,
  TERMINAL_OFFER_STATUSES,
  TERMINAL_POOL_STATUSES,
} from '../../src/services/dispatch.rules.js';

/**
 * The dispatch rules as data.
 *
 * Three other things depend on this module being right: the services (which call
 * these instead of re-deciding), the constraints in 09-driver-dispatch.sql (which
 * encode the same state machines) and the tests that exercise concurrency. A
 * mistake here would be enforced consistently and therefore invisibly.
 */

const WEIGHTS = Object.freeze({
  rejectionPenaltySeconds: 60,
  workloadPenaltySeconds: 30,
  idleCreditPerMinuteSeconds: 5,
  idleCreditMaxSeconds: 180,
});

const candidate = (overrides = {}) => ({
  driverProfileId: 'driver-a',
  score: 100,
  availableSince: new Date('2026-09-24T10:00:00.000Z'),
  ...overrides,
});

describe('driver availability', () => {
  it('has exactly the four documented states', () => {
    assert.deepStrictEqual([...DRIVER_AVAILABILITIES].sort(), [
      'AVAILABLE',
      'OFFLINE',
      'ON_RIDE',
      'RESERVED',
    ]);
  });

  it('dispatches only to an AVAILABLE driver', () => {
    assert.strictEqual(DISPATCHABLE_AVAILABILITY, 'AVAILABLE');

    for (const status of DRIVER_AVAILABILITIES) {
      assert.strictEqual(
        status === 'AVAILABLE',
        status === DISPATCHABLE_AVAILABILITY,
        status,
      );
    }
  });

  it('allows exactly the documented changes and no others', () => {
    const allowed = [];

    for (const from of DRIVER_AVAILABILITIES) {
      for (const to of DRIVER_AVAILABILITIES) {
        if (canChangeAvailability(from, to)) allowed.push(`${from}->${to}`);
      }
    }

    assert.deepStrictEqual(allowed.sort(), [
      'AVAILABLE->OFFLINE',
      'AVAILABLE->RESERVED',
      'OFFLINE->AVAILABLE',
      'ON_RIDE->AVAILABLE',
      'RESERVED->OFFLINE',
      'RESERVED->ON_RIDE',
    ]);
  });

  it('implements only the three changes this milestone performs', () => {
    const implemented = [];

    for (const from of DRIVER_AVAILABILITIES) {
      for (const to of DRIVER_AVAILABILITIES) {
        if (isImplementedAvailabilityChange(from, to)) implemented.push(`${from}->${to}`);
      }
    }

    assert.deepStrictEqual(implemented.sort(), [
      'AVAILABLE->OFFLINE',
      'AVAILABLE->RESERVED',
      'OFFLINE->AVAILABLE',
    ]);
  });

  it('reserves the trip transitions: allowed by the product, unreachable from the API', () => {
    for (const { from, to } of [
      { from: 'RESERVED', to: 'ON_RIDE' },
      { from: 'ON_RIDE', to: 'AVAILABLE' },
      { from: 'RESERVED', to: 'OFFLINE' },
    ]) {
      assert.strictEqual(canChangeAvailability(from, to), true, `${from}->${to}`);
      assert.strictEqual(isImplementedAvailabilityChange(from, to), false, `${from}->${to}`);
    }
  });

  it('never implements a change the product does not allow', () => {
    for (const from of DRIVER_AVAILABILITIES) {
      for (const to of DRIVER_AVAILABILITIES) {
        if (isImplementedAvailabilityChange(from, to)) {
          assert.strictEqual(canChangeAvailability(from, to), true, `${from}->${to}`);
        }
      }
    }
  });

  it('lets only a free driver go offline', () => {
    assert.strictEqual(canGoOffline('AVAILABLE'), true);

    // A reserved driver has accepted a passenger and an on-ride driver is
    // driving one: releasing either is an operator decision, not a device.
    for (const status of ['OFFLINE', 'RESERVED', 'ON_RIDE']) {
      assert.strictEqual(canGoOffline(status), false, status);
    }
  });

  it('lets an offline or available driver go online, but not a committed one', () => {
    assert.strictEqual(canGoOnline('OFFLINE'), true);
    assert.strictEqual(canGoOnline('AVAILABLE'), true);
    assert.strictEqual(canGoOnline('RESERVED'), false);
    assert.strictEqual(canGoOnline('ON_RIDE'), false);
  });

  it('lets a free driver move, but not one already on their way to a pickup', () => {
    assert.strictEqual(canSetCurrentServicePoint('OFFLINE'), true);
    assert.strictEqual(canSetCurrentServicePoint('AVAILABLE'), true);
    assert.strictEqual(canSetCurrentServicePoint('RESERVED'), false);
    assert.strictEqual(canSetCurrentServicePoint('ON_RIDE'), false);
  });

  it('answers unknown values with false instead of throwing', () => {
    for (const value of ['offline', '', null, undefined, 'toString', 'constructor', 42]) {
      assert.strictEqual(isDriverAvailability(value), false, String(value));
      assert.strictEqual(canGoOnline(value), false, String(value));
      assert.strictEqual(canChangeAvailability(value, 'AVAILABLE'), false, String(value));
      // A prototype key must not be mistaken for a transition list.
      assert.strictEqual(canChangeAvailability('AVAILABLE', value), false, String(value));
    }
  });

  it('keeps the reserved transitions inside the allowed table', () => {
    for (const from of Object.keys(IMPLEMENTED_AVAILABILITY_TRANSITIONS)) {
      for (const to of IMPLEMENTED_AVAILABILITY_TRANSITIONS[from]) {
        assert.ok(
          AVAILABILITY_TRANSITIONS[from].includes(to),
          `${from}->${to} is implemented but not allowed`,
        );
      }
    }
  });
});

describe('offers', () => {
  it('has exactly the two offer types, and dispatch creates only the initial one', () => {
    assert.deepStrictEqual(Object.values(OFFER_TYPE).sort(), ['ADD_PASSENGER', 'INITIAL_RIDE']);
    // ADD_PASSENGER is real, and it is not dispatch's: matching.service.js proposes
    // one for a pool that already exists.
    assert.strictEqual(IMPLEMENTED_OFFER_TYPE, 'INITIAL_RIDE');
  });

  it('has exactly the five offer statuses', () => {
    assert.deepStrictEqual([...OFFER_STATUSES].sort(), [
      'ACCEPTED',
      'CANCELLED',
      'EXPIRED',
      'PENDING',
      'REJECTED',
    ]);
  });

  it('treats every non-pending offer as terminal', () => {
    assert.strictEqual(isTerminalOfferStatus('PENDING'), false);
    assert.strictEqual(isPendingOffer('PENDING'), true);

    for (const status of TERMINAL_OFFER_STATUSES) {
      assert.strictEqual(isTerminalOfferStatus(status), true, status);
      assert.strictEqual(isPendingOffer(status), false, status);
      assert.notStrictEqual(status, 'PENDING');
    }

    assert.deepStrictEqual(
      [...OFFER_STATUSES].filter((status) => !isTerminalOfferStatus(status)),
      ['PENDING'],
    );
  });

  it('offers exactly the four reasons, with OTHER as the default', () => {
    assert.deepStrictEqual([...REJECTION_REASONS], [
      'TOO_FAR',
      'UNAVAILABLE',
      'VEHICLE_ISSUE',
      'OTHER',
    ]);
    assert.strictEqual(DEFAULT_REJECTION_REASON, 'OTHER');
    assert.ok(REJECTION_REASONS.includes(DEFAULT_REJECTION_REASON));
  });

  it('recognises only real statuses and reasons', () => {
    for (const status of OFFER_STATUSES) assert.strictEqual(isOfferStatus(status), true, status);
    for (const reason of REJECTION_REASONS) assert.strictEqual(isRejectionReason(reason), true, reason);

    for (const value of ['pending', '', null, undefined, 1, ['PENDING']]) {
      assert.strictEqual(isOfferStatus(value), false, JSON.stringify(value));
      assert.strictEqual(isRejectionReason(value), false, JSON.stringify(value));
    }
  });

  it('expires an offer at its deadline, not after it', () => {
    const offer = { expiresAt: new Date('2026-09-24T10:00:30.000Z') };

    assert.strictEqual(isOfferExpired(offer, new Date('2026-09-24T10:00:29.999Z')), false);
    assert.strictEqual(isOfferExpired(offer, new Date('2026-09-24T10:00:30.000Z')), true);
    assert.strictEqual(isOfferExpired(offer, new Date('2026-09-24T10:00:30.001Z')), true);
  });
});

describe('pools, members and stops', () => {
  it('has exactly the six pool statuses', () => {
    assert.deepStrictEqual([...POOL_STATUSES].sort(), [
      'ARRIVED',
      'CANCELLED',
      'COMPLETED',
      'DRIVER_EN_ROUTE',
      'FORMING',
      'IN_PROGRESS',
    ]);
  });

  it('partitions pool statuses into active and terminal, with nothing left over', () => {
    assert.deepStrictEqual(
      [...ACTIVE_POOL_STATUSES, ...TERMINAL_POOL_STATUSES].sort(),
      [...POOL_STATUSES].sort(),
    );

    for (const status of POOL_STATUSES) {
      assert.notStrictEqual(isActivePoolStatus(status), TERMINAL_POOL_STATUSES.includes(status));
    }
  });

  it('counts an en-route, arrived or in-progress pool as still occupying the driver', () => {
    // The partial unique index one_active_pool_per_driver covers exactly these, so
    // the rule inherits into the trip milestones without a new index.
    assert.deepStrictEqual([...ACTIVE_POOL_STATUSES], [
      'FORMING',
      'DRIVER_EN_ROUTE',
      'ARRIVED',
      'IN_PROGRESS',
    ]);
  });

  it('creates only FORMING in this milestone', () => {
    assert.strictEqual(IMPLEMENTED_POOL_STATUS, POOL_STATUS.FORMING);
  });

  it('records the initial plan as pickup first, drop-off second', () => {
    assert.strictEqual(PICKUP_SEQUENCE, 1);
    assert.strictEqual(DROPOFF_SEQUENCE - PICKUP_SEQUENCE, 1);
  });

  it('has the documented member, stop and event vocabularies', () => {
    assert.deepStrictEqual(Object.values(POOL_MEMBER_STATUS).sort(), [
      'ASSIGNED',
      'CANCELLED',
      'DROPPED_OFF',
      'NO_SHOW',
      'PICKED_UP',
    ]);
    assert.deepStrictEqual(Object.values(POOL_STOP_TYPE).sort(), ['DROPOFF', 'PICKUP']);
    assert.deepStrictEqual(Object.values(POOL_STOP_STATUS).sort(), [
      'ARRIVED',
      'COMPLETED',
      'PENDING',
      'SKIPPED',
    ]);
    assert.ok(Object.values(POOL_ACTOR_TYPE).includes('DRIVER'));
    assert.ok(Object.values(POOL_EVENT_TYPE).includes('POOL_CREATED'));
    assert.ok(Object.values(POOL_EVENT_TYPE).includes('MEMBER_ADDED'));
    assert.ok(Object.values(POOL_EVENT_TYPE).includes('ROUTE_PLAN_CREATED'));
  });
});

describe('candidateScore', () => {
  it('is the routed approach duration when nothing else applies', () => {
    assert.strictEqual(
      candidateScore({ approachDurationSeconds: 240, weights: WEIGHTS }),
      240,
    );
  });

  it('adds a penalty for each recent refusal and each recent acceptance', () => {
    assert.strictEqual(
      candidateScore({ approachDurationSeconds: 100, recentRejections: 2, weights: WEIGHTS }),
      100 + 2 * 60,
    );
    assert.strictEqual(
      candidateScore({
        approachDurationSeconds: 100,
        acceptedOffersRecently: 3,
        weights: WEIGHTS,
      }),
      100 + 3 * 30,
    );
  });

  it('credits idle time by the minute, and caps the credit', () => {
    assert.strictEqual(
      candidateScore({ approachDurationSeconds: 100, idleSeconds: 90, weights: WEIGHTS }),
      100 - 5,
    );

    // Ten minutes of idling earns 50 seconds...
    assert.strictEqual(
      candidateScore({ approachDurationSeconds: 100, idleSeconds: 600, weights: WEIGHTS }),
      100 - 50,
    );

    // ...but the credit stops at 180 seconds, so a driver who has waited a week
    // cannot outrank one who is two minutes away.
    assert.strictEqual(
      candidateScore({ approachDurationSeconds: 100, idleSeconds: 7 * 24 * 3600, weights: WEIGHTS }),
      0,
    );
  });

  it('never returns a negative score', () => {
    assert.strictEqual(
      candidateScore({ approachDurationSeconds: 0, idleSeconds: 3600, weights: WEIGHTS }),
      0,
    );
  });

  it('is deterministic and takes every weight from configuration', () => {
    const input = { approachDurationSeconds: 200, recentRejections: 1, idleSeconds: 300 };

    assert.strictEqual(
      candidateScore({ ...input, weights: WEIGHTS }),
      candidateScore({ ...input, weights: WEIGHTS }),
    );

    // Turning the penalties off isolates proximity, which is what the weights
    // exist for: dispatch can be tuned without touching the ranking logic.
    assert.strictEqual(
      candidateScore({
        ...input,
        weights: {
          rejectionPenaltySeconds: 0,
          workloadPenaltySeconds: 0,
          idleCreditPerMinuteSeconds: 0,
          idleCreditMaxSeconds: 0,
        },
      }),
      200,
    );
  });

  it('treats a driver standing at the pickup as the best possible candidate', () => {
    assert.strictEqual(candidateScore({ approachDurationSeconds: 0, weights: WEIGHTS }), 0);
  });
});

describe('candidate ordering', () => {
  it('ranks the lowest score first', () => {
    const near = candidate({ driverProfileId: 'near', score: 120 });
    const far = candidate({ driverProfileId: 'far', score: 400 });

    assert.strictEqual(bestCandidate([far, near]), near);
    assert.deepStrictEqual([far, near].sort(compareCandidates).map((c) => c.driverProfileId), [
      'near',
      'far',
    ]);
  });

  it('breaks a score tie on the longest idle time', () => {
    const waiting = candidate({
      driverProfileId: 'z-waiting',
      score: 200,
      availableSince: new Date('2026-09-24T09:00:00.000Z'),
    });
    const fresh = candidate({
      driverProfileId: 'a-fresh',
      score: 200,
      availableSince: new Date('2026-09-24T09:30:00.000Z'),
    });

    // An earlier availableSince means a longer idle time, and it wins even
    // though the other id sorts first.
    assert.strictEqual(bestCandidate([fresh, waiting]), waiting);
  });

  it('breaks a remaining tie on the driver id, so the choice is reproducible', () => {
    const at = new Date('2026-09-24T10:00:00.000Z');
    const a = candidate({ driverProfileId: 'aaaa-0000', score: 200, availableSince: at });
    const b = candidate({ driverProfileId: 'bbbb-1111', score: 200, availableSince: at });

    assert.strictEqual(bestCandidate([b, a]), a);
    assert.strictEqual(bestCandidate([a, b]), a);
    // The same set in any order gives the same winner.
    assert.deepStrictEqual(
      [b, a].sort(compareCandidates).map((c) => c.driverProfileId),
      [a, b].sort(compareCandidates).map((c) => c.driverProfileId),
    );
  });

  it('does not mutate the list it is given', () => {
    const candidates = [candidate({ score: 5 }), candidate({ score: 1 })];
    const before = [...candidates];

    bestCandidate(candidates);

    assert.deepStrictEqual(candidates, before);
  });

  it('returns null when there is nobody to choose from', () => {
    assert.strictEqual(bestCandidate([]), null);
  });
});

describe('buildProposalSnapshot', () => {
  const snapshot = () =>
    buildProposalSnapshot({
      pickup: { code: 'banani-road-11', name: 'Banani Road 11' },
      destination: { code: 'mohakhali-bus-terminal', name: 'Mohakhali Bus Terminal' },
      approach: {
        fromServicePointCode: 'banani-kakoli',
        distanceMeters: 445,
        durationSeconds: 114,
      },
      passengerRoute: { distanceMeters: 2214, durationSeconds: 569 },
      vehicle: { name: 'Bullet', seatCapacity: 3 },
      requestedAt: new Date('2026-09-24T02:41:30.000Z'),
    });

  it('records what the driver was offered', () => {
    const built = snapshot();

    assert.deepStrictEqual(built.pickup, { code: 'banani-road-11', name: 'Banani Road 11' });
    assert.deepStrictEqual(built.destination, {
      code: 'mohakhali-bus-terminal',
      name: 'Mohakhali Bus Terminal',
    });
    assert.deepStrictEqual(built.approach, {
      fromServicePointCode: 'banani-kakoli',
      distanceMeters: 445,
      durationSeconds: 114,
    });
    assert.deepStrictEqual(built.passengerRoute, { distanceMeters: 2214, durationSeconds: 569 });
    assert.deepStrictEqual(built.vehicle, { name: 'Bullet', seatCapacity: 3 });
    assert.strictEqual(built.requestedAt, '2026-09-24T02:41:30.000Z');
  });

  it('holds no passenger identity, no money and no internals', () => {
    const serialized = JSON.stringify(snapshot());

    for (const forbidden of [
      'passengerProfileId',
      'passengerId',
      'userId',
      'fare',
      'fareQuoteId',
      'score',
      'fingerprint',
      'idempotency',
      'Nusrat',
    ]) {
      assert.ok(!serialized.includes(forbidden), `the snapshot must not contain ${forbidden}`);
    }
  });

  it('records the point the approach was measured from, so acceptance can trust it', () => {
    // Acceptance compares this with where the driver is at acceptance time; if it
    // were missing, "you have moved since this offer was made" could not be said.
    assert.strictEqual(snapshot().approach.fromServicePointCode, 'banani-kakoli');
  });
});
