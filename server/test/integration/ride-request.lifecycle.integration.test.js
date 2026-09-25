import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';

import { env } from '../../src/config/env.js';
import { createSoloFareQuote } from '../../src/services/fare.service.js';
import {
  cancelRideRequest,
  createRideRequest,
  expireOverdueRideRequests,
  listRideEvents,
  listRideRequestsForPassenger,
} from '../../src/services/ride-request.service.js';
import { closePool, expectPgError, pool, prepareDatabase, withRollback } from '../helpers/db.js';

/**
 * The lifecycle at the level it is actually enforced: the database, and the
 * service that has to answer for it.
 *
 * The API suite proves what a client can reach. This one proves what happens when
 * something reaches past the service -- a migration, a script, a future feature,
 * a race -- which is the level these rules were designed for. Every constraint
 * here exists in 08-ride-requests.sql rather than only in JavaScript, so the
 * tests write straight to the tables through `withRollback` (always rolled back)
 * and assert the SQLSTATE.
 *
 * SQLSTATEs used below:
 *   23505 - unique violation (the idempotency key, the quote, the active slot)
 *   23514 - check or trigger violation (a CHECK, or an immutability guard)
 *   23503 - foreign key violation (deleting a quote a request still refers to)
 *   22P02 - invalid text representation (a value that is not an enum label)
 */

const ORIGIN = 'banani-road-11';
const DESTINATION = 'mohakhali-bus-terminal';
const DEPARTURE = new Date('2026-09-24T08:41:00+06:00');

const INSERT_REQUEST = `
  INSERT INTO ride_requests (
    passenger_profile_id, fare_quote_id, pickup_service_point_id, dropoff_service_point_id,
    status, requested_at, search_expires_at, started_at, completed_at,
    cancelled_at, cancellation_reason,
    idempotency_key, request_fingerprint, accepted_fare, currency,
    accepted_pricing_code, accepted_pricing_version,
    accepted_distance_meters, accepted_duration_seconds
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
  RETURNING id`;

let nusrat;
let rafiq;
let points;
/** Every insert gets its own key and fingerprint so no two collide by accident. */
let sequence = 0;

const key = () => `suite-key-${Date.now()}-${(sequence += 1)}`;
const fingerprint = () => String(sequence).padStart(64, 'a');

/**
 * A request inserted directly, for the tests that need to reach the database
 * without the service's own checks in the way. Each call makes a fresh quote,
 * because a quote may be accepted only once.
 */
const insertRequest = async (exec, overrides = {}) => {
  const requestedAt = overrides.requestedAt ?? new Date('2026-09-24T02:41:30.000Z');
  const quote =
    overrides.quote ??
    (await createSoloFareQuote({
      passengerProfileId: (overrides.passengerProfileId ?? nusrat.profileId) ?? null,
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: DEPARTURE,
    })).quote;

  const row = {
    passengerProfileId: nusrat.profileId,
    fareQuoteId: quote.id,
    pickupServicePointId: points[ORIGIN],
    dropoffServicePointId: points[DESTINATION],
    status: 'WAITING',
    requestedAt,
    searchExpiresAt: new Date(requestedAt.getTime() + env.rideRequests.searchTtlSeconds * 1000),
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    idempotencyKey: key(),
    requestFingerprint: fingerprint(),
    acceptedFare: '130.630000',
    currency: 'BDT',
    acceptedPricingCode: 'dhaka-solo',
    acceptedPricingVersion: 1,
    acceptedDistanceMeters: 2214,
    acceptedDurationSeconds: 569,
    ...overrides,
  };

  // A request's status and the ride's own instants have to agree
  // (`ride_requests_lifecycle_consistent`), so a fixture that fabricates a state
  // fills in what that state implies.
  if (['IN_PROGRESS', 'COMPLETED'].includes(row.status) && row.startedAt === null) {
    row.startedAt = new Date('2026-09-24T02:45:00.000Z');
  }
  if (row.status === 'COMPLETED' && row.completedAt === null) {
    row.completedAt = new Date('2026-09-24T03:05:00.000Z');
  }

  const { rows } = await exec.query(INSERT_REQUEST, [
    row.passengerProfileId,
    row.fareQuoteId,
    row.pickupServicePointId,
    row.dropoffServicePointId,
    row.status,
    row.requestedAt,
    row.searchExpiresAt,
    row.startedAt,
    row.completedAt,
    row.cancelledAt,
    row.cancellationReason,
    row.idempotencyKey,
    row.requestFingerprint,
    row.acceptedFare,
    row.currency,
    row.acceptedPricingCode,
    row.acceptedPricingVersion,
    row.acceptedDistanceMeters,
    row.acceptedDurationSeconds,
  ]);

  return rows[0].id;
};

/** A real request, created the way the API creates one. */
const requestRide = (passenger = nusrat) =>
  createSoloFareQuote({
    passengerProfileId: passenger.profileId,
    originServicePointCode: ORIGIN,
    destinationServicePointCode: DESTINATION,
    departureAt: DEPARTURE,
  }).then(({ quote }) =>
    createRideRequest({
      passenger: { id: passenger.userId, role: 'PASSENGER', passengerProfile: { id: passenger.profileId } },
      fareQuoteId: quote.id,
      idempotencyKey: key(),
    }),
  );

const countRequests = async (exec, sql = '', params = []) =>
  Number(
    (await exec.query(`SELECT count(*)::int AS count FROM ride_requests ${sql}`, params)).rows[0]
      .count,
  );

before(async () => {
  await prepareDatabase();

  const users = await pool.user.findMany({
    where: { email: { in: ['nusrat@example.com', 'rafiq@example.com'] } },
    select: { id: true, email: true, passengerProfile: { select: { id: true } } },
  });
  const byEmail = new Map(users.map((user) => [user.email, user]));

  nusrat = {
    userId: byEmail.get('nusrat@example.com').id,
    profileId: byEmail.get('nusrat@example.com').passengerProfile.id,
  };
  rafiq = {
    userId: byEmail.get('rafiq@example.com').id,
    profileId: byEmail.get('rafiq@example.com').passengerProfile.id,
  };

  const servicePoints = await pool.servicePoint.findMany({
    where: { code: { in: [ORIGIN, DESTINATION] } },
    select: { id: true, code: true },
  });
  points = Object.fromEntries(servicePoints.map((point) => [point.code, point.id]));
});

beforeEach(async () => {
  // One active request per passenger is a database rule, so each test needs the
  // floor clear before it starts.
  await pool.query(`DELETE FROM ride_requests`);
});

after(async () => {
  await pool.query(`DELETE FROM ride_requests`);
  await closePool();
});

describe('one request per passenger per key', () => {
  it('refuses a second request with the same passenger and idempotency key', async () => {
    await withRollback(async (tx) => {
      const shared = key();
      await insertRequest(tx, { idempotencyKey: shared });

      // A different quote, so the quote is not what refuses this one.
      await expectPgError(
        tx,
        () => insertRequest(tx, { idempotencyKey: shared }),
        '23505',
      );
    });
  });

  it('lets two passengers use the same key', async () => {
    await withRollback(async (tx) => {
      const shared = key();
      await insertRequest(tx, { idempotencyKey: shared });
      await insertRequest(tx, { idempotencyKey: shared, passengerProfileId: rafiq.profileId });
    });
  });

  it('accepts a quote only once', async () => {
    await withRollback(async (tx) => {
      const quote = (
        await createSoloFareQuote({
          passengerProfileId: nusrat.profileId,
          originServicePointCode: ORIGIN,
          destinationServicePointCode: DESTINATION,
          departureAt: DEPARTURE,
        })
      ).quote;

      await insertRequest(tx, { quote });

      await expectPgError(
        tx,
        // A different passenger, so only the quote can refuse this one.
        () => insertRequest(tx, { quote, passengerProfileId: rafiq.profileId }),
        '23505',
      );
    });
  });
});

describe('one active request per passenger', () => {
  it('refuses two waiting requests for the same passenger', async () => {
    await withRollback(async (tx) => {
      await insertRequest(tx, { status: 'WAITING' });
      await expectPgError(tx, () => insertRequest(tx, { status: 'WAITING' }), '23505');
    });
  });

  it('counts a matched or in-progress request as active', async () => {
    for (const status of ['MATCHED', 'IN_PROGRESS']) {
      await withRollback(async (tx) => {
        await insertRequest(tx, { status });
        await expectPgError(tx, () => insertRequest(tx, { status: 'WAITING' }), '23505');
      });
    }
  });

  it('allows several finished requests, and a new active one behind them', async () => {
    await withRollback(async (tx) => {
      await insertRequest(tx, {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: 'CHANGED_MIND',
      });
      await insertRequest(tx, { status: 'EXPIRED' });
      await insertRequest(tx, { status: 'COMPLETED' });

      // The slot is free again once nothing is in flight.
      await insertRequest(tx, { status: 'WAITING' });

      assert.strictEqual(await countRequests(tx), 4);
    });
  });
});

describe('the row is checked as a whole', () => {
  it('refuses a search window that is inverted or empty', async () => {
    await withRollback(async (tx) => {
      const requestedAt = new Date('2026-09-24T02:41:30.000Z');

      const errored = await expectPgError(
        tx,
        () => insertRequest(tx, { requestedAt, searchExpiresAt: requestedAt }),
        '23514',
      );
      assert.match(errored.message, /search_window_valid/);

      await expectPgError(
        tx,
        () =>
          insertRequest(tx, {
            requestedAt,
            searchExpiresAt: new Date(requestedAt.getTime() - 1),
          }),
        '23514',
      );
    });
  });

  it('refuses a journey from a point to itself', async () => {
    await withRollback(async (tx) => {
      await expectPgError(
        tx,
        () => insertRequest(tx, { dropoffServicePointId: points[ORIGIN] }),
        '23514',
      );
    });
  });

  it('refuses a cancellation that is not complete', async () => {
    await withRollback(async (tx) => {
      // CANCELLED without a time or a reason is not a cancellation.
      await expectPgError(tx, () => insertRequest(tx, { status: 'CANCELLED' }), '23514');
      await expectPgError(
        tx,
        () =>
          insertRequest(tx, {
            status: 'CANCELLED',
            cancelledAt: new Date(),
          }),
        '23514',
      );
    });
  });

  it('refuses cancellation columns on a request that is not cancelled', async () => {
    await withRollback(async (tx) => {
      for (const status of ['WAITING', 'EXPIRED', 'MATCHED', 'IN_PROGRESS', 'COMPLETED']) {
        await expectPgError(
          tx,
          () =>
            insertRequest(tx, {
              status,
              cancelledAt: new Date(),
              cancellationReason: 'CHANGED_MIND',
            }),
          '23514',
        );
      }
    });
  });

  it('refuses an idempotency key or fingerprint that is not the documented shape', async () => {
    await withRollback(async (tx) => {
      for (const bad of ['short', 'x'.repeat(129), 'has space', 'has/slash', 'unicode-😀-key']) {
        await expectPgError(tx, () => insertRequest(tx, { idempotencyKey: bad }), '23514');
      }

      for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'zz'.repeat(32), '']) {
        await expectPgError(tx, () => insertRequest(tx, { requestFingerprint: bad }), '23514');
      }
    });
  });

  it('refuses money, distance, duration or a version that is not a real amount', async () => {
    await withRollback(async (tx) => {
      await expectPgError(tx, () => insertRequest(tx, { acceptedFare: '-0.000001' }), '23514');
      await expectPgError(tx, () => insertRequest(tx, { acceptedDistanceMeters: 0 }), '23514');
      await expectPgError(tx, () => insertRequest(tx, { acceptedDurationSeconds: 0 }), '23514');
      await expectPgError(tx, () => insertRequest(tx, { acceptedPricingVersion: 0 }), '23514');

      // A free ride is representable: zero is an amount, a negative one is not.
      await insertRequest(tx, { acceptedFare: '0' });
    });
  });

  it('refuses a currency that is not a three-letter code', async () => {
    await withRollback(async (tx) => {
      for (const bad of ['bdt', 'BD', 'BDTX', 'BD1', '']) {
        await expectPgError(tx, () => insertRequest(tx, { currency: bad }), '23514');
      }
    });
  });

  it('refuses a status the enum does not have', async () => {
    await withRollback(async (tx) => {
      const errored = await expectPgError(
        tx,
        () => insertRequest(tx, { status: 'PENDING' }),
        '22P02',
      );

      assert.match(errored.message, /ride_request_status/);
    });
  });

  it('will not let a quote be deleted while a request refers to it', async () => {
    await withRollback(async (tx) => {
      const quote = (
        await createSoloFareQuote({
          passengerProfileId: nusrat.profileId,
          originServicePointCode: ORIGIN,
          destinationServicePointCode: DESTINATION,
          departureAt: DEPARTURE,
        })
      ).quote;

      await insertRequest(tx, { quote });

      // RESTRICT: the quote is the evidence behind an accepted fare, so it
      // cannot disappear from under the request that accepted it.
      await expectPgError(
        tx,
        () => tx.query(`DELETE FROM fare_quotes WHERE id = $1::uuid`, [quote.id]),
        '23503',
      );
    });
  });
});

describe('history is append-only', () => {
  const FROZEN = [
    ['passenger_profile_id', 'passenger_profile_id = $2'],
    ['fare_quote_id', 'fare_quote_id = NULL'],
    ['pickup_service_point_id', 'pickup_service_point_id = dropoff_service_point_id'],
    ['dropoff_service_point_id', 'dropoff_service_point_id = pickup_service_point_id'],
    ['requested_at', `requested_at = requested_at + interval '1 hour'`],
    ['idempotency_key', `idempotency_key = 'a-different-key'`],
    ['request_fingerprint', `request_fingerprint = repeat('b', 64)`],
    ['accepted_fare', `accepted_fare = accepted_fare + 1`],
    ['currency', `currency = 'USD'`],
    ['accepted_pricing_code', `accepted_pricing_code = 'dhaka-pool'`],
    ['accepted_pricing_version', `accepted_pricing_version = 2`],
    ['accepted_distance_meters', `accepted_distance_meters = 1`],
    ['accepted_duration_seconds', `accepted_duration_seconds = 1`],
  ];

  it('refuses an update of the passenger, the quote, the endpoints or the accepted fare', async () => {
    await withRollback(async (tx) => {
      const id = await insertRequest(tx);

      for (const [column, assignment] of FROZEN) {
        const params = column === 'passenger_profile_id' ? [id, rafiq.profileId] : [id];
        const errored = await expectPgError(
          tx,
          () => tx.query(`UPDATE ride_requests SET ${assignment} WHERE id = $1::uuid`, params),
          '23514',
        );

        assert.match(errored.message, /immutable/, `${column} must be immutable`);
      }
    });
  });

  it('allows the reserved transitions, so matching needs no migration', async () => {
    await withRollback(async (tx) => {
      const requestId = await insertRequest(tx, { status: 'WAITING' });

      await tx.query(`UPDATE ride_requests SET status = 'MATCHED' WHERE id = $1::uuid`, [requestId]);
      await tx.query(
        `UPDATE ride_requests SET status = 'IN_PROGRESS', started_at = now() WHERE id = $1::uuid`,
        [requestId],
      );
      await tx.query(
        `UPDATE ride_requests SET status = 'COMPLETED', completed_at = now() WHERE id = $1::uuid`,
        [requestId],
      );

      const { rows } = await tx.query(`SELECT status FROM ride_requests WHERE id = $1::uuid`, [
        requestId,
      ]);
      assert.strictEqual(rows[0].status, 'COMPLETED');
    });
  });

  it('refuses a transition the product does not allow, including out of a terminal status', async () => {
    await withRollback(async (tx) => {
      // Two active statuses cannot belong to the same passenger (that is the
      // partial unique index), so the matched one is Rafiq's.
      const waiting = await insertRequest(tx, { status: 'WAITING' });
      const matched = await insertRequest(tx, {
        status: 'MATCHED',
        passengerProfileId: rafiq.profileId,
      });
      const cancelled = await insertRequest(tx, {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: 'OTHER',
      });
      const completed = await insertRequest(tx, { status: 'COMPLETED' });

      for (const [id, status] of [
        [waiting, 'COMPLETED'],
        [waiting, 'IN_PROGRESS'],
        [matched, 'EXPIRED'],
        [matched, 'WAITING'],
        [cancelled, 'WAITING'],
        [cancelled, 'EXPIRED'],
        [completed, 'CANCELLED'],
      ]) {
        const errored = await expectPgError(
          tx,
          () => tx.query(`UPDATE ride_requests SET status = $2 WHERE id = $1::uuid`, [id, status]),
          '23514',
        );

        assert.match(errored.message, /illegal ride request transition/);
      }
    });
  });

  it('refuses any update of an event', async () => {
    await withRollback(async (tx) => {
      const requestId = await insertRequest(tx);
      await tx.query(
        `INSERT INTO ride_events (ride_request_id, sequence, event_type, actor_type, new_status)
         VALUES ($1, 1, 'RIDE_REQUESTED', 'PASSENGER', 'WAITING')`,
        [requestId],
      );

      const errored = await expectPgError(
        tx,
        () => tx.query(`UPDATE ride_events SET metadata = '{"edited":true}' WHERE ride_request_id = $1::uuid`, [
          requestId,
        ]),
        '23514',
      );

      assert.match(errored.message, /append-only/);
    });
  });

  it('refuses a duplicated, non-positive or non-object event', async () => {
    await withRollback(async (tx) => {
      const requestId = await insertRequest(tx);
      const insert = (sequenceNumber, metadata) =>
        tx.query(
          `INSERT INTO ride_events (ride_request_id, sequence, event_type, actor_type, new_status, metadata)
           VALUES ($1, $2, 'RIDE_REQUESTED', 'PASSENGER', 'WAITING', $3::jsonb)`,
          [requestId, sequenceNumber, metadata],
        );

      await insert(1, '{}');

      await expectPgError(tx, () => insert(1, '{}'), '23505');
      await expectPgError(tx, () => insert(0, '{}'), '23514');
      await expectPgError(tx, () => insert(-3, '{}'), '23514');
      await expectPgError(tx, () => insert(2, '[]'), '23514');
      await expectPgError(tx, () => insert(2, '"text"'), '23514');
    });
  });

  it('keeps history in order, numbered from one', async () => {
    await withRollback(async (tx) => {
      const requestId = await insertRequest(tx);

      await tx.query(
        `INSERT INTO ride_events (ride_request_id, sequence, event_type, actor_type, new_status)
         VALUES ($1, 1, 'RIDE_REQUESTED', 'PASSENGER', 'WAITING')`,
        [requestId],
      );
      await tx.query(
        `UPDATE ride_requests SET status = 'CANCELLED', cancelled_at = now(),
                cancellation_reason = 'WAIT_TOO_LONG' WHERE id = $1::uuid`,
        [requestId],
      );
      await tx.query(
        `INSERT INTO ride_events (ride_request_id, sequence, event_type, actor_type,
                                  previous_status, new_status, metadata)
         VALUES ($1, 2, 'RIDE_CANCELLED', 'PASSENGER', 'WAITING', 'CANCELLED', '{"reason":"WAIT_TOO_LONG"}')`,
        [requestId],
      );

      const { rows } = await tx.query(
        `SELECT sequence, event_type FROM ride_events WHERE ride_request_id = $1::uuid ORDER BY sequence`,
        [requestId],
      );

      assert.deepStrictEqual(
        rows.map((row) => [row.sequence, row.event_type]),
        [
          [1, 'RIDE_REQUESTED'],
          [2, 'RIDE_CANCELLED'],
        ],
      );
    });
  });

  it('takes the events with it when a request is deleted', async () => {
    await withRollback(async (tx) => {
      const requestId = await insertRequest(tx);
      await tx.query(
        `INSERT INTO ride_events (ride_request_id, sequence, event_type, actor_type, new_status)
         VALUES ($1, 1, 'RIDE_REQUESTED', 'PASSENGER', 'WAITING')`,
        [requestId],
      );

      await tx.query(`DELETE FROM ride_requests WHERE id = $1::uuid`, [requestId]);

      const { rows } = await tx.query(
        `SELECT count(*)::int AS count FROM ride_events WHERE ride_request_id = $1::uuid`,
        [requestId],
      );

      assert.strictEqual(rows[0].count, 0, 'an orphaned event explains nothing');
    });
  });
});

describe('the service refuses what the database would refuse', () => {
  it('will not cancel a request the database has moved on', async () => {
    const { request } = await requestRide();
    // Matching does not exist yet, but the database already allows it; a request
    // that reached MATCHED must not be cancellable by this milestone's operation.
    await pool.query(`UPDATE ride_requests SET status = 'MATCHED' WHERE id = $1::uuid`, [
      request.id,
    ]);

    await assert.rejects(
      () =>
        cancelRideRequest({
          passenger: {
            id: nusrat.userId,
            role: 'PASSENGER',
            passengerProfile: { id: nusrat.profileId },
          },
          rideRequestId: request.id,
        }),
      (err) => {
        assert.strictEqual(err.statusCode, 409);
        assert.match(err.message, /cannot be cancelled/);
        return true;
      },
    );

    // The refusal must not have written anything.
    const events = await listRideEvents(request.id);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].eventType, 'RIDE_REQUESTED');

    const { rows } = await pool.query(`SELECT status FROM ride_requests WHERE id = $1::uuid`, [
      request.id,
    ]);
    assert.strictEqual(rows[0].status, 'MATCHED');
  });

  it('refuses a passenger who has no profile rather than guessing one', async () => {
    const { quote } = await createSoloFareQuote({
      passengerProfileId: nusrat.profileId,
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: DEPARTURE,
    });

    await assert.rejects(
      () =>
        createRideRequest({
          passenger: { id: nusrat.userId, role: 'PASSENGER', passengerProfile: null },
          fareQuoteId: quote.id,
          idempotencyKey: key(),
        }),
      (err) => {
        assert.strictEqual(err.statusCode, 403);
        return true;
      },
    );
  });
});

describe('expiration', () => {
  const passenger = () => ({
    id: nusrat.userId,
    role: 'PASSENGER',
    passengerProfile: { id: nusrat.profileId },
  });

  it('expires a request only once its search window has closed', async () => {
    const { request } = await requestRide();

    // Before the deadline, with the deadline itself injected: nothing happens.
    const before = await expireOverdueRideRequests({
      now: new Date(new Date(request.searchExpiresAt).getTime() - 1),
    });
    assert.deepStrictEqual(before, { examined: 0, expired: 0, skipped: 0 });

    const { rows: stillWaiting } = await pool.query(
      `SELECT status FROM ride_requests WHERE id = $1::uuid`,
      [request.id],
    );
    assert.strictEqual(stillWaiting[0].status, 'WAITING');

    // At the deadline the window is closed, which is the boundary the sweep uses.
    const after = await expireOverdueRideRequests({ now: new Date(request.searchExpiresAt) });
    assert.deepStrictEqual(after, { examined: 1, expired: 1, skipped: 0 });

    const { rows: expiredRow } = await pool.query(
      `SELECT status, cancelled_at, cancellation_reason FROM ride_requests WHERE id = $1::uuid`,
      [request.id],
    );
    assert.strictEqual(expiredRow[0].status, 'EXPIRED');
    assert.strictEqual(expiredRow[0].cancelled_at, null, 'expiry is not a cancellation');
    assert.strictEqual(expiredRow[0].cancellation_reason, null);
  });

  it('records the expiration as a system event, with no user behind it', async () => {
    const { request } = await requestRide();
    await expireOverdueRideRequests({ now: new Date(request.searchExpiresAt) });

    const events = await listRideEvents(request.id);

    assert.deepStrictEqual(
      events.map((event) => [event.sequence, event.eventType, event.actorType]),
      [
        [1, 'RIDE_REQUESTED', 'PASSENGER'],
        [2, 'RIDE_EXPIRED', 'SYSTEM'],
      ],
    );
    assert.strictEqual(events[1].actorUserId, null);
    assert.strictEqual(events[1].previousStatus, 'WAITING');
    assert.strictEqual(events[1].newStatus, 'EXPIRED');
  });

  it('is idempotent: a second sweep finds nothing left to expire', async () => {
    const { request } = await requestRide();
    const at = new Date(request.searchExpiresAt);

    await expireOverdueRideRequests({ now: at });
    const second = await expireOverdueRideRequests({ now: at });

    assert.deepStrictEqual(second, { examined: 0, expired: 0, skipped: 0 });
    assert.strictEqual((await listRideEvents(request.id)).length, 2);
  });

  it('leaves a cancelled request alone, even past its deadline', async () => {
    const { request } = await requestRide();
    await cancelRideRequest({
      passenger: passenger(),
      rideRequestId: request.id,
      reason: 'CHANGED_MIND',
    });

    const summary = await expireOverdueRideRequests({ now: new Date(new Date(request.searchExpiresAt).getTime() + 60_000) });

    assert.deepStrictEqual(summary, { examined: 0, expired: 0, skipped: 0 });

    const events = await listRideEvents(request.id);
    assert.deepStrictEqual(
      events.map((event) => event.eventType),
      ['RIDE_REQUESTED', 'RIDE_CANCELLED'],
    );
  });

  it('does not touch a request whose window is still open', async () => {
    const { request } = await requestRide();

    // The real clock, which cannot be past a window that was just opened.
    const summary = await expireOverdueRideRequests();

    assert.deepStrictEqual(summary, { examined: 0, expired: 0, skipped: 0 });
    const { rows } = await pool.query(`SELECT status FROM ride_requests WHERE id = $1::uuid`, [
      request.id,
    ]);
    assert.strictEqual(rows[0].status, 'WAITING');
  });

  it('frees the passenger?s slot, so they can request a ride again', async () => {
    const first = await requestRide();
    await expireOverdueRideRequests({ now: new Date(first.request.searchExpiresAt) });

    const second = await requestRide();

    assert.notStrictEqual(second.request.id, first.request.id);
    assert.strictEqual(second.request.status, 'WAITING');
  });

  it('ships as a command a scheduler can run', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

    assert.strictEqual(
      manifest.scripts['ride-requests:expire'],
      'node src/commands/expire-ride-requests.js',
    );
  });
});

describe('concurrency', () => {
  const passenger = () => ({
    id: nusrat.userId,
    role: 'PASSENGER',
    passengerProfile: { id: nusrat.profileId },
  });

  const quoteFor = (forPassenger = nusrat) =>
    createSoloFareQuote({
      passengerProfileId: forPassenger.profileId,
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: DEPARTURE,
    });

  /** Runs `count` attempts at once and reports how each one finished. */
  const race = async (attempts) => {
    const results = await Promise.allSettled(attempts.map((attempt) => attempt()));

    return results.map((result) =>
      result.status === 'fulfilled'
        ? { ok: true, replay: result.value.replay, id: result.value.request.id }
        : { ok: false, status: result.reason.statusCode, message: result.reason.message },
    );
  };

  const create = (quoteId, idempotencyKey) =>
    createRideRequest({ passenger: passenger(), fareQuoteId: quoteId, idempotencyKey });

  it('creates one request when two different quotes are used at once', async () => {
    const [first, second] = await Promise.all([quoteFor(), quoteFor()]);

    const results = await race([
      () => create(first.quote.id, key()),
      () => create(second.quote.id, key()),
    ]);

    assert.strictEqual(results.filter((result) => result.ok).length, 1);
    assert.strictEqual(await countRequests(pool), 1, 'exactly one request may exist');

    const [loser] = results.filter((result) => !result.ok);
    assert.strictEqual(loser.status, 409);
    assert.match(loser.message, /already has an active ride request/);
  });

  it('creates one request when one quote is used twice at once', async () => {
    const { quote } = await quoteFor();

    const results = await race([
      () => create(quote.id, key()),
      () => create(quote.id, key()),
    ]);

    assert.strictEqual(results.filter((result) => result.ok).length, 1);
    assert.strictEqual(await countRequests(pool), 1);

    const [loser] = results.filter((result) => !result.ok);
    assert.strictEqual(loser.status, 409);
    assert.match(loser.message, /already been used/);
  });

  it('answers a genuine simultaneous retry with the request, not with a conflict', async () => {
    const { quote } = await quoteFor();
    const shared = key();

    const results = await race([() => create(quote.id, shared), () => create(quote.id, shared)]);

    // Both callers asked for the same thing with the same key, so both get it --
    // one created it, the other replayed it.
    assert.ok(
      results.every((result) => result.ok),
      `a same-key race must replay, got ${JSON.stringify(results)}`,
    );
    assert.strictEqual(new Set(results.map((result) => result.id)).size, 1);
    assert.deepStrictEqual(
      results.map((result) => result.replay).sort(),
      [false, true],
    );
    assert.strictEqual(await countRequests(pool), 1);

    const events = await listRideEvents(results[0].id);
    assert.strictEqual(events.length, 1, 'a replay must not append a second event');
  });

  it('creates one request when the same key is sent with two different quotes at once', async () => {
    const [first, second] = await Promise.all([quoteFor(), quoteFor()]);
    const shared = key();

    const results = await race([
      () => create(first.quote.id, shared),
      () => create(second.quote.id, shared),
    ]);

    assert.strictEqual(results.filter((result) => result.ok).length, 1);
    assert.strictEqual(await countRequests(pool), 1);

    const [loser] = results.filter((result) => !result.ok);
    assert.strictEqual(loser.status, 409, 'one key cannot mean two requests');
  });

  it('never creates two events for one request', async () => {
    const [first, second] = await Promise.all([quoteFor(), quoteFor()]);

    await race([
      () => create(first.quote.id, key()),
      () => create(second.quote.id, key()),
    ]);

    const { rows } = await pool.query(`SELECT count(*)::int AS count FROM ride_events`);
    assert.strictEqual(rows[0].count, 1, 'only the winner writes history');
  });
});

describe('a failed operation leaves nothing behind', () => {
  const passenger = () => ({
    id: nusrat.userId,
    role: 'PASSENGER',
    passengerProfile: { id: nusrat.profileId },
  });

  const counts = async () => ({
    requests: await countRequests(pool),
    events: Number((await pool.query(`SELECT count(*)::int AS count FROM ride_events`)).rows[0].count),
  });

  it('writes neither a request nor an event when the quote is refused', async () => {
    const { quote } = await createSoloFareQuote({
      passengerProfileId: rafiq.profileId,
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: DEPARTURE,
    });

    const before = await counts();

    await assert.rejects(() =>
      createRideRequest({
        passenger: passenger(),
        fareQuoteId: quote.id,
        idempotencyKey: key(),
      }),
    );

    assert.deepStrictEqual(await counts(), before);
  });

  it('writes nothing when a second request is refused for the active slot', async () => {
    await requestRide();
    const { quote } = await createSoloFareQuote({
      passengerProfileId: nusrat.profileId,
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: DEPARTURE,
    });

    const before = await counts();

    await assert.rejects(() =>
      createRideRequest({
        passenger: passenger(),
        fareQuoteId: quote.id,
        idempotencyKey: key(),
      }),
    );

    assert.deepStrictEqual(await counts(), before);
  });

  it('writes nothing when a cancellation is refused', async () => {
    const { request } = await requestRide();
    await cancelRideRequest({
      passenger: passenger(),
      rideRequestId: request.id,
      reason: 'OTHER',
    });

    const before = await counts();

    await assert.rejects(() =>
      cancelRideRequest({ passenger: passenger(), rideRequestId: request.id, reason: 'OTHER' }),
    );

    assert.deepStrictEqual(await counts(), before);
    assert.strictEqual((await listRideEvents(request.id)).length, 2);
  });
});

describe('the passenger clock is injectable', () => {
  it('records the requested, expiry and cancellation instants it is given', async () => {
    const requestedAt = new Date('2026-09-24T02:41:30.000Z');
    const cancelledAt = new Date('2026-09-24T02:44:00.000Z');

    const { quote } = await createSoloFareQuote({
      passengerProfileId: nusrat.profileId,
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: DEPARTURE,
    });

    const passenger = {
      id: nusrat.userId,
      role: 'PASSENGER',
      passengerProfile: { id: nusrat.profileId },
    };

    const created = await createRideRequest({
      passenger,
      fareQuoteId: quote.id,
      idempotencyKey: key(),
      now: requestedAt,
    });

    assert.strictEqual(created.request.requestedAt.toISOString(), requestedAt.toISOString());
    assert.strictEqual(
      created.request.searchExpiresAt.toISOString(),
      new Date(requestedAt.getTime() + env.rideRequests.searchTtlSeconds * 1000).toISOString(),
    );

    const cancelled = await cancelRideRequest({
      passenger,
      rideRequestId: created.request.id,
      reason: 'OTHER',
      now: cancelledAt,
    });

    assert.strictEqual(cancelled.cancelledAt.toISOString(), cancelledAt.toISOString());

    const { rows } = await pool.query(
      `SELECT requested_at, cancelled_at FROM ride_requests WHERE id = $1::uuid`,
      [created.request.id],
    );
    assert.strictEqual(new Date(rows[0].requested_at).toISOString(), requestedAt.toISOString());
    assert.strictEqual(new Date(rows[0].cancelled_at).toISOString(), cancelledAt.toISOString());
  });

  it('orders a history with equal instants deterministically', async () => {
    const { quote: firstQuote } = await createSoloFareQuote({
      passengerProfileId: nusrat.profileId,
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: DEPARTURE,
    });
    const { quote: secondQuote } = await createSoloFareQuote({
      passengerProfileId: nusrat.profileId,
      originServicePointCode: ORIGIN,
      destinationServicePointCode: DESTINATION,
      departureAt: DEPARTURE,
    });

    const passenger = {
      id: nusrat.userId,
      role: 'PASSENGER',
      passengerProfile: { id: nusrat.profileId },
    };
    const at = new Date('2026-09-24T02:41:30.000Z');

    const first = await createRideRequest({
      passenger,
      fareQuoteId: firstQuote.id,
      idempotencyKey: key(),
      now: at,
    });
    await cancelRideRequest({
      passenger,
      rideRequestId: first.request.id,
      reason: 'OTHER',
      now: at,
    });

    const second = await createRideRequest({
      passenger,
      fareQuoteId: secondQuote.id,
      idempotencyKey: key(),
      now: at,
    });

    // Same instant, so only the tie-break can decide: the order must still be
    // stable rather than whichever row the planner happened to return first. The
    // tie-break is the id, descending, and a UUID compares by its bytes -- which
    // for lower-case hex is the same order as its text.
    const page = await listRideRequestsForPassenger({ passenger, limit: 10, offset: 0 });

    assert.strictEqual(page.total, 2);
    assert.deepStrictEqual(
      page.requests.map((request) => request.id),
      [first.request.id, second.request.id].sort().reverse(),
    );
  });
});
