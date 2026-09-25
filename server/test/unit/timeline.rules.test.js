import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TIMELINE,
  TIMELINE_AUDIENCE,
  TIMELINE_EVENT_TYPES,
  TIMELINE_PHASE,
  compareTimelineEntries,
  isVisibleTo,
  toTimeline,
  toTimelineEntry,
  visibleEventTypes,
} from '../../src/services/timeline.rules.js';

/**
 * The timeline mapper: which internal event a person may be told about, and what
 * they are told.
 *
 * The assertions are about the boundary rather than about the labels. A label is
 * presentation and may be reworded; "a passenger is never shown that a driver
 * refused their ride", and "an event payload never reaches a client", are the
 * properties the product depends on.
 */

const { PASSENGER, DRIVER } = TIMELINE_AUDIENCE;

const event = (eventType, sequence, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  sequence,
  eventType,
  actorType: 'SYSTEM',
  createdAt: new Date('2026-09-25T12:00:00.000Z'),
  ...extra,
});

describe('what a passenger may be shown', () => {
  it('maps their own journey and nothing else', () => {
    const timeline = toTimeline(
      [
        event('RIDE_REQUESTED', 1),
        event('PASSENGER_MATCHED', 2),
        event('DRIVER_ARRIVED', 3),
        event('PASSENGER_PICKED_UP', 4),
        event('RIDE_STARTED', 5),
        event('PASSENGER_DROPPED_OFF', 6),
        event('RIDE_COMPLETED', 7),
      ],
      PASSENGER,
    );

    assert.deepStrictEqual(
      timeline.map((entry) => entry.eventType),
      [
        'RIDE_REQUESTED',
        'PASSENGER_MATCHED',
        'DRIVER_ARRIVED',
        'PASSENGER_PICKED_UP',
        'RIDE_STARTED',
        'PASSENGER_DROPPED_OFF',
        'RIDE_COMPLETED',
      ],
    );
  });

  it('shows nothing about the dispatch machinery', () => {
    // The whole dispatch family: who was asked, how they answered, what a
    // candidate scored, that a join offer was made to somebody. None of it is
    // about the passenger's journey, and all of it is about other people.
    for (const eventType of [
      'DRIVER_OFFERED',
      'DRIVER_REJECTED',
      'DRIVER_OFFER_EXPIRED',
      'DRIVER_OFFER_CANCELLED',
      'POOL_CANDIDATE_EVALUATED',
      'POOL_JOIN_OFFERED',
      'POOL_JOIN_REJECTED',
      'INITIAL_DISPATCH_FALLBACK',
    ]) {
      assert.strictEqual(isVisibleTo(eventType, PASSENGER), false, eventType);
      assert.strictEqual(toTimelineEntry(event(eventType, 1), PASSENGER), null, eventType);
    }
  });

  it('shows nothing about the pool the car belongs to', () => {
    // A pool's history names its members and its plan. A passenger is told about
    // their own ride instead, from their own ride events.
    const poolOnly = [
      'POOL_CREATED',
      'MEMBER_ADDED',
      'SHARED_FARE_CALCULATED',
      'SHARED_FARE_SUPERSEDED',
      'DRIVER_DEPARTED',
      'STOP_ARRIVED',
      'MEMBER_PICKED_UP',
      'TRIP_STARTED',
      'MEMBER_DROPPED_OFF',
      'TRIP_COMPLETED',
      'DRIVER_AVAILABLE',
    ];

    for (const eventType of poolOnly) {
      assert.strictEqual(isVisibleTo(eventType, PASSENGER), false, eventType);
    }
  });

  it('shows the passenger their own fare events, without an amount', () => {
    const timeline = toTimeline(
      [event('PASSENGER_FARE_ALLOCATED', 4), event('PASSENGER_FARE_REDUCED', 5)],
      PASSENGER,
    );

    assert.deepStrictEqual(
      timeline.map((entry) => entry.eventType),
      ['PASSENGER_FARE_ALLOCATED', 'PASSENGER_FARE_REDUCED'],
    );

    // The label is a sentence; the money lives in the response's own fare block,
    // so there is one answer rather than two that can disagree.
    for (const entry of timeline) {
      assert.doesNotMatch(entry.label, /\d/);
    }
  });

  it('tells the passenger when somebody joined their shared ride', () => {
    // Included, and the only event about another person that is: the number of
    // people in the car is already published as an aggregate, so this discloses
    // nothing new -- and a shared-ride timeline that omitted the second pickup
    // would misdescribe the product. The label names nobody.
    const [entry] = toTimeline([event('POOL_JOIN_ACCEPTED', 2)], PASSENGER);

    assert.ok(entry);
    assert.doesNotMatch(entry.label, /Nusrat|Rafiq|Jashim/);
  });
});

describe('what a driver may be shown', () => {
  it('maps their own pool lifecycle', () => {
    const timeline = toTimeline(
      [
        event('POOL_CREATED', 1),
        event('MEMBER_ADDED', 2),
        event('DRIVER_DEPARTED', 3),
        event('STOP_ARRIVED', 4),
        event('MEMBER_PICKED_UP', 5),
        event('TRIP_STARTED', 6),
        event('MEMBER_DROPPED_OFF', 7),
        event('TRIP_COMPLETED', 8),
        event('DRIVER_AVAILABLE', 9),
      ],
      DRIVER,
    );

    assert.strictEqual(timeline.length, 9);
    assert.deepStrictEqual(timeline.map((entry) => entry.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('is not shown a passenger\'s ride events', () => {
    // `ride_events` belong to one passenger's request. A driver gets the pool's
    // own log, and never the passenger's record.
    const passengerOnly = visibleEventTypes(PASSENGER);

    assert.ok(passengerOnly.length > 0);
    for (const eventType of passengerOnly) {
      assert.strictEqual(isVisibleTo(eventType, DRIVER), false, eventType);
    }
  });

  it('gives each event type exactly one label per audience it lists', () => {
    for (const [eventType, entry] of Object.entries(TIMELINE)) {
      assert.ok(entry.audiences.length > 0, eventType);
      assert.deepStrictEqual(Object.keys(entry.labels).sort(), [...entry.audiences].sort(), eventType);
      for (const label of Object.values(entry.labels)) {
        assert.ok(label.trim().length > 0, eventType);
      }
    }
  });
});

describe('the whitelist is the safety property', () => {
  it('makes an unknown event invisible to everybody', () => {
    // This is what a new milestone's enum value does by default: it is recorded
    // for audit and told to nobody until somebody decides what it means and to
    // whom. A blacklist would have leaked it on the day it was added.
    const unknown = event('SOMETHING_ADDED_LATER', 1);

    assert.strictEqual(isVisibleTo(unknown.eventType, PASSENGER), false);
    assert.strictEqual(isVisibleTo(unknown.eventType, DRIVER), false);
    assert.deepStrictEqual(toTimeline([unknown], PASSENGER), []);
    assert.deepStrictEqual(toTimeline([unknown], DRIVER), []);
  });

  it('survives a malformed row rather than throwing', () => {
    assert.strictEqual(toTimelineEntry(null, PASSENGER), null);
    assert.strictEqual(toTimelineEntry(undefined, PASSENGER), null);
    assert.strictEqual(toTimelineEntry({}, PASSENGER), null);
    assert.deepStrictEqual(toTimeline(null, PASSENGER), []);
    assert.deepStrictEqual(toTimeline(undefined, PASSENGER), []);
  });

  it('never copies an event payload or an actor id into an entry', () => {
    const entry = toTimelineEntry(
      event('PASSENGER_PICKED_UP', 3, {
        metadata: { driverProfileId: 'secret', score: 42, poolVersion: 1 },
        actorUserId: 'ffffffff-0000-4000-8000-000000000001',
        previousStatus: 'MATCHED',
        newStatus: 'IN_PROGRESS',
      }),
      PASSENGER,
    );

    assert.deepStrictEqual(Object.keys(entry).sort(), [
      'actorType',
      'at',
      'eventType',
      'label',
      'phase',
      'sequence',
    ]);
    assert.doesNotMatch(JSON.stringify(entry), /secret|score|ffffffff/);
  });

  it('carries no identifier that could address a person or a row', () => {
    for (const audience of [PASSENGER, DRIVER]) {
      for (const eventType of visibleEventTypes(audience)) {
        const entry = toTimelineEntry(
          event(eventType, 1, { metadata: { rideRequestId: 'x' }, actorUserId: 'y' }),
          audience,
        );

        assert.deepStrictEqual(Object.keys(entry).sort(), [
          'actorType',
          'at',
          'eventType',
          'label',
          'phase',
          'sequence',
        ]);
      }
    }
  });
});

describe('ordering', () => {
  it('is by sequence, then timestamp, then id — never the input order', () => {
    const scrambled = [
      event('TRIP_COMPLETED', 3),
      event('POOL_CREATED', 1),
      event('DRIVER_DEPARTED', 2),
    ];

    assert.deepStrictEqual(
      toTimeline(scrambled, DRIVER).map((entry) => entry.sequence),
      [1, 2, 3],
    );
  });

  it('breaks a sequence tie with the timestamp, then the id', () => {
    const earlier = event('STOP_ARRIVED', 1, {
      createdAt: new Date('2026-09-25T12:00:00.000Z'),
    });
    const later = event('STOP_ARRIVED', 1, {
      createdAt: new Date('2026-09-25T12:00:05.000Z'),
    });

    assert.ok(compareTimelineEntries(earlier, later) < 0);
    assert.ok(compareTimelineEntries(later, earlier) > 0);

    // Same sequence, same instant: the id decides, so the order is still total.
    const first = { ...earlier, id: '00000000-0000-4000-8000-00000000000a' };
    const second = { ...earlier, id: '00000000-0000-4000-8000-00000000000b' };

    assert.ok(compareTimelineEntries(first, second) < 0);
    assert.strictEqual(toTimeline([second, first], DRIVER).length, 2);
  });

  it('does not mutate the array it was given', () => {
    const input = [event('TRIP_COMPLETED', 3), event('POOL_CREATED', 1)];
    const copy = [...input];

    toTimeline(input, DRIVER);

    assert.deepStrictEqual(input, copy);
  });
});

describe('the phase a client groups by', () => {
  it('is one of the five the schema declares, for every event type', () => {
    const phases = Object.values(TIMELINE_PHASE);

    for (const entry of Object.values(TIMELINE)) {
      assert.ok(phases.includes(entry.phase), entry.phase);
    }
  });

  it('puts the end of a journey in END and the beginning in REQUEST', () => {
    assert.strictEqual(TIMELINE.RIDE_REQUESTED.phase, TIMELINE_PHASE.REQUEST);
    assert.strictEqual(TIMELINE.RIDE_COMPLETED.phase, TIMELINE_PHASE.END);
    assert.strictEqual(TIMELINE.RIDE_STARTED.phase, TIMELINE_PHASE.RIDE);
    assert.strictEqual(TIMELINE.PASSENGER_PICKED_UP.phase, TIMELINE_PHASE.PICKUP);
  });
});

describe('the vocabulary itself', () => {
  it('has no duplicate key, so no table can shadow another', () => {
    // The two event enums share a vocabulary. One entry per type is what keeps a
    // merged lookup from silently preferring whichever was spread second.
    assert.strictEqual(new Set(TIMELINE_EVENT_TYPES).size, TIMELINE_EVENT_TYPES.length);
  });

  it('does not invent a passenger-facing departure event', () => {
    // Departure writes a *pool* event; nothing writes a ride event for it. A
    // passenger learns their driver set off from `stage` and `departedAt` on
    // their own response, so mapping a ride event here would be describing a row
    // that does not exist.
    assert.strictEqual(isVisibleTo('DRIVER_DEPARTED', PASSENGER), false);
    assert.strictEqual(isVisibleTo('DRIVER_DEPARTED', DRIVER), true);
  });

  it('leaves the reserved pool events unmapped', () => {
    assert.strictEqual(TIMELINE.POOL_STATUS_CHANGED, undefined);
    assert.strictEqual(TIMELINE.POOL_CANCELLED, undefined);
  });
});
