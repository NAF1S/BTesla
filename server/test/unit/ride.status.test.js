import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTIVE_RIDE_REQUEST_STATUSES,
  ALLOWED_TRANSITIONS,
  CANCELLATION_REASONS,
  DEFAULT_CANCELLATION_REASON,
  IMPLEMENTED_TRANSITIONS,
  RIDE_ACTOR_TYPE,
  RIDE_EVENT_TYPE,
  RIDE_REQUEST_STATUS,
  RIDE_REQUEST_STATUSES,
  TERMINAL_RIDE_REQUEST_STATUSES,
  canTransition,
  isActiveStatus,
  isCancellable,
  isCancellationReason,
  isImplementedTransition,
  isRideRequestStatus,
  isTerminalStatus,
  requestFingerprint,
} from '../../src/services/ride.status.js';

/**
 * The lifecycle rules as data.
 *
 * These tests matter because three other things depend on this module being
 * right: the service (which only ever calls `canTransition` through
 * `applyTransition`), the database trigger in 08-ride-requests.sql (which
 * encodes the same table), and the API's job of rejecting a status change that
 * no operation implements. A mistake here would be enforced consistently and
 * therefore invisibly.
 */

const TRANSITION_PAIRS = () =>
  RIDE_REQUEST_STATUSES.flatMap((from) =>
    RIDE_REQUEST_STATUSES.map((to) => ({ from, to })),
  );

describe('ride request statuses', () => {
  it('defines exactly the six statuses of the lifecycle', () => {
    assert.deepStrictEqual([...RIDE_REQUEST_STATUSES].sort(), [
      'CANCELLED',
      'COMPLETED',
      'EXPIRED',
      'IN_PROGRESS',
      'MATCHED',
      'WAITING',
    ]);
  });

  it('partitions the statuses into active and terminal, with nothing left over', () => {
    assert.deepStrictEqual(
      [...ACTIVE_RIDE_REQUEST_STATUSES, ...TERMINAL_RIDE_REQUEST_STATUSES].sort(),
      [...RIDE_REQUEST_STATUSES].sort(),
    );

    // The two sets are disjoint: a status cannot both occupy the passenger's
    // single active slot and be finished.
    for (const status of ACTIVE_RIDE_REQUEST_STATUSES) {
      assert.strictEqual(isTerminalStatus(status), false, `${status} must not be terminal`);
    }
    for (const status of RIDE_REQUEST_STATUSES) {
      assert.notStrictEqual(isActiveStatus(status), isTerminalStatus(status), status);
    }
  });

  it('counts a matched or in-progress request as still occupying the active slot', () => {
    // The partial unique index in 08-ride-requests.sql covers exactly these, so a
    // passenger cannot start a second ride while one is under way.
    assert.deepStrictEqual([...ACTIVE_RIDE_REQUEST_STATUSES], ['WAITING', 'MATCHED', 'IN_PROGRESS']);
  });

  it('recognises only real statuses', () => {
    for (const status of RIDE_REQUEST_STATUSES) {
      assert.strictEqual(isRideRequestStatus(status), true, status);
    }

    for (const value of ['waiting', '', null, undefined, 42, {}, ['WAITING'], 'PENDING']) {
      assert.strictEqual(isRideRequestStatus(value), false, JSON.stringify(value));
    }
  });
});

describe('ride request transitions', () => {
  it('allows exactly the documented transitions and no others', () => {
    const allowed = TRANSITION_PAIRS()
      .filter(({ from, to }) => canTransition(from, to))
      .map(({ from, to }) => `${from}->${to}`)
      .sort();

    assert.deepStrictEqual(allowed, [
      'IN_PROGRESS->COMPLETED',
      'MATCHED->CANCELLED',
      'MATCHED->IN_PROGRESS',
      'WAITING->CANCELLED',
      'WAITING->EXPIRED',
      'WAITING->MATCHED',
    ]);
  });

  it('keeps terminal statuses terminal', () => {
    for (const status of TERMINAL_RIDE_REQUEST_STATUSES) {
      assert.deepStrictEqual([...ALLOWED_TRANSITIONS[status]], [], status);
      for (const to of RIDE_REQUEST_STATUSES) {
        assert.strictEqual(canTransition(status, to), false, `${status}->${to}`);
      }
    }
  });

  it('never allows a status to move to itself', () => {
    for (const status of RIDE_REQUEST_STATUSES) {
      assert.strictEqual(canTransition(status, status), false, status);
    }
  });

  it('never skips a step: no status may jump straight to COMPLETED', () => {
    for (const from of ['WAITING', 'MATCHED', 'COMPLETED', 'CANCELLED', 'EXPIRED']) {
      assert.strictEqual(canTransition(from, 'COMPLETED'), false, from);
    }
  });

  it('implements the three transitions this milestone performs', () => {
    const implemented = TRANSITION_PAIRS()
      .filter(({ from, to }) => isImplementedTransition(from, to))
      .map(({ from, to }) => `${from}->${to}`)
      .sort();

    assert.deepStrictEqual(implemented, [
      'WAITING->CANCELLED',
      'WAITING->EXPIRED',
      // A driver accepting a dispatch offer is what performs this one.
      'WAITING->MATCHED',
    ]);
  });

  it('reserves the trip transitions for later: allowed, but unreachable', () => {
    for (const { from, to } of [
      { from: 'MATCHED', to: 'IN_PROGRESS' },
      { from: 'MATCHED', to: 'CANCELLED' },
      { from: 'IN_PROGRESS', to: 'COMPLETED' },
    ]) {
      assert.strictEqual(canTransition(from, to), true, `${from}->${to} must stay legal`);
      assert.strictEqual(
        isImplementedTransition(from, to),
        false,
        `${from}->${to} must not be implemented yet`,
      );
    }
  });

  it('never implements a transition the product does not allow', () => {
    for (const { from, to } of TRANSITION_PAIRS()) {
      if (isImplementedTransition(from, to)) {
        assert.strictEqual(canTransition(from, to), true, `${from}->${to}`);
      }
    }
  });

  it('answers unknown statuses with false instead of throwing', () => {
    for (const value of ['PENDING', '', null, undefined, 'toString', 'constructor']) {
      assert.strictEqual(canTransition(value, 'WAITING'), false, String(value));
      assert.strictEqual(isImplementedTransition(value, 'WAITING'), false, String(value));
      assert.strictEqual(canTransition('WAITING', value), false, String(value));
    }
  });
});

describe('cancellation', () => {
  it('is offered only while a request is waiting', () => {
    assert.strictEqual(isCancellable(RIDE_REQUEST_STATUS.WAITING), true);

    for (const status of RIDE_REQUEST_STATUSES.filter((s) => s !== 'WAITING')) {
      assert.strictEqual(
        isCancellable(status),
        false,
        `${status} must not be cancellable in this milestone`,
      );
    }
  });

  it('offers exactly the four reasons, with OTHER as the default', () => {
    assert.deepStrictEqual([...CANCELLATION_REASONS], [
      'CHANGED_MIND',
      'WRONG_LOCATION',
      'WAIT_TOO_LONG',
      'OTHER',
    ]);
    assert.strictEqual(DEFAULT_CANCELLATION_REASON, 'OTHER');
    assert.ok(CANCELLATION_REASONS.includes(DEFAULT_CANCELLATION_REASON));
  });

  it('recognises only real reasons', () => {
    for (const reason of CANCELLATION_REASONS) {
      assert.strictEqual(isCancellationReason(reason), true, reason);
    }
    for (const value of ['changed_mind', '', null, undefined, 1, ['OTHER']]) {
      assert.strictEqual(isCancellationReason(value), false, JSON.stringify(value));
    }
  });
});

describe('event and actor vocabularies', () => {
  it('records the events of every implemented step', () => {
    assert.strictEqual(RIDE_EVENT_TYPE.RIDE_REQUESTED, 'RIDE_REQUESTED');
    assert.strictEqual(RIDE_EVENT_TYPE.RIDE_CANCELLED, 'RIDE_CANCELLED');
    assert.strictEqual(RIDE_EVENT_TYPE.RIDE_EXPIRED, 'RIDE_EXPIRED');
  });

  it('reserves event types for matching and the trip itself', () => {
    assert.deepStrictEqual(
      [
        RIDE_EVENT_TYPE.PASSENGER_MATCHED,
        RIDE_EVENT_TYPE.RIDE_STARTED,
        RIDE_EVENT_TYPE.RIDE_COMPLETED,
        RIDE_EVENT_TYPE.PASSENGER_PICKED_UP,
        RIDE_EVENT_TYPE.PASSENGER_DROPPED_OFF,
      ],
      ['PASSENGER_MATCHED', 'RIDE_STARTED', 'RIDE_COMPLETED', 'PASSENGER_PICKED_UP', 'PASSENGER_DROPPED_OFF'],
    );
  });

  it('attributes an event to a passenger, the system, or an administrator', () => {
    assert.deepStrictEqual(Object.values(RIDE_ACTOR_TYPE).sort(), ['ADMIN', 'PASSENGER', 'SYSTEM']);
  });
});

const FINGERPRINT_INPUT = Object.freeze({
  passengerProfileId: '11111111-1111-1111-1111-111111111111',
  fareQuoteId: '22222222-2222-2222-2222-222222222222',
  pickupServicePointId: '33333333-3333-3333-3333-333333333333',
  dropoffServicePointId: '44444444-4444-4444-4444-444444444444',
  acceptedFare: '130.63',
  currency: 'BDT',
  acceptedPricingCode: 'dhaka-solo',
  acceptedPricingVersion: 1,
  acceptedDistanceMeters: 2214,
  acceptedDurationSeconds: 569,
});

describe('requestFingerprint', () => {
  it('is a 64 character hex digest', () => {
    assert.match(requestFingerprint(FINGERPRINT_INPUT), /^[0-9a-f]{64}$/);
  });

  it('is deterministic and independent of the property order of its input', () => {
    const reordered = Object.fromEntries(
      Object.entries(FINGERPRINT_INPUT).reverse(),
    );

    assert.strictEqual(
      requestFingerprint(reordered),
      requestFingerprint(FINGERPRINT_INPUT),
    );
    assert.strictEqual(
      requestFingerprint({ ...FINGERPRINT_INPUT }),
      requestFingerprint(FINGERPRINT_INPUT),
    );
  });

  it('changes when any part of the agreement changes', () => {
    const baseline = requestFingerprint(FINGERPRINT_INPUT);

    const variants = {
      passengerProfileId: 'aaaaaaaa-1111-1111-1111-111111111111',
      fareQuoteId: 'aaaaaaaa-2222-2222-2222-222222222222',
      pickupServicePointId: 'aaaaaaaa-3333-3333-3333-333333333333',
      dropoffServicePointId: 'aaaaaaaa-4444-4444-4444-444444444444',
      acceptedFare: '130.64',
      currency: 'USD',
      acceptedPricingCode: 'dhaka-solo-v2',
      acceptedPricingVersion: 2,
      acceptedDistanceMeters: 2215,
      acceptedDurationSeconds: 570,
    };

    for (const [field, value] of Object.entries(variants)) {
      assert.notStrictEqual(
        requestFingerprint({ ...FINGERPRINT_INPUT, [field]: value }),
        baseline,
        `a different ${field} must not reproduce the same fingerprint`,
      );
    }
  });

  it('treats a Decimal, a string and a number for the same fare alike', () => {
    // The service passes a Prisma.Decimal; a test may pass the string it prints.
    // Both must fingerprint the same request, or a retry would look like a
    // different one and be rejected as a key conflict.
    const asString = requestFingerprint({ ...FINGERPRINT_INPUT, acceptedFare: '130.63' });
    const asExactNumber = requestFingerprint({ ...FINGERPRINT_INPUT, acceptedFare: 130.63 });
    const decimalLike = requestFingerprint({
      ...FINGERPRINT_INPUT,
      acceptedFare: { toString: () => '130.63' },
    });

    assert.strictEqual(asExactNumber, asString);
    assert.strictEqual(decimalLike, asString);
  });

  it('separates the fields, so shuffled values cannot collide', () => {
    // Concatenating inputs without a delimiter would make these the same string.
    const swapped = requestFingerprint({
      ...FINGERPRINT_INPUT,
      pickupServicePointId: FINGERPRINT_INPUT.dropoffServicePointId,
      dropoffServicePointId: FINGERPRINT_INPUT.pickupServicePointId,
    });

    assert.notStrictEqual(swapped, requestFingerprint(FINGERPRINT_INPUT));
  });
});
