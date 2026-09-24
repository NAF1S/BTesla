import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_RUSH_HOUR_WINDOWS,
  isWithinRushHour,
  minutesSinceMidnightIn,
  parseRushHourWindows,
  resolveTrafficProfile,
  TRAFFIC_PROFILE,
} from '../../src/utils/time.js';

/**
 * Traffic-profile selection.
 *
 * Everything here is deterministic: the window boundaries are asserted through
 * fixed instants rather than the current clock, because the profile a route is
 * estimated with must not depend on when the test suite happens to run.
 *
 * Asia/Dhaka is UTC+06:00 with no daylight saving, so 06:41Z is 12:41 local and
 * 02:41Z is 08:41 local.
 */

const at = (iso) => new Date(iso);
const WINDOWS = parseRushHourWindows(DEFAULT_RUSH_HOUR_WINDOWS);

describe('parseRushHourWindows', () => {
  it('parses the configured default into minutes of day', () => {
    assert.deepStrictEqual(
      parseRushHourWindows(DEFAULT_RUSH_HOUR_WINDOWS),
      [
        { startMinutes: 7 * 60 + 30, endMinutes: 10 * 60 + 30 },
        { startMinutes: 16 * 60 + 30, endMinutes: 20 * 60 },
      ],
    );
  });

  it('accepts a single window and tolerates whitespace', () => {
    assert.deepStrictEqual(parseRushHourWindows(' 09:00 - 10:00 '), [
      { startMinutes: 540, endMinutes: 600 },
    ]);
  });

  it('accepts a window that wraps past midnight', () => {
    assert.deepStrictEqual(parseRushHourWindows('22:00-02:00'), [
      { startMinutes: 1320, endMinutes: 120 },
    ]);
    assert.strictEqual(isWithinRushHour(at('2026-09-24T17:00:00Z'), parseRushHourWindows('22:00-02:00')), true);
    assert.strictEqual(isWithinRushHour(at('2026-09-24T06:00:00Z'), parseRushHourWindows('22:00-02:00')), false);
  });

  it('rejects a malformed specification instead of guessing', () => {
    for (const spec of [
      '',
      '   ',
      '07:30',
      '07:30-',
      '7:70-10:00',
      '24:00-25:00',
      '07:30-07:30',
      'morning',
      '07:30 - 10:30, oops',
    ]) {
      assert.throws(() => parseRushHourWindows(spec), Error, `expected "${spec}" to be rejected`);
    }
  });
});

describe('minutesSinceMidnightIn', () => {
  it('reads the wall clock in Asia/Dhaka, not UTC', () => {
    assert.strictEqual(minutesSinceMidnightIn(at('2026-09-24T02:41:00Z')), 8 * 60 + 41);
    // Midnight is the case that trips naive hour formatting: 18:00Z is 00:00.
    assert.strictEqual(minutesSinceMidnightIn(at('2026-09-24T18:00:00Z')), 0);
    assert.strictEqual(minutesSinceMidnightIn(at('2026-09-24T18:30:00Z')), 30);
    // 23:59Z is 05:59 the next day in Dhaka.
    assert.strictEqual(minutesSinceMidnightIn(at('2026-09-24T23:59:00Z')), 5 * 60 + 59);
  });

  it('uses the offset of the requested zone, so the same instant reads differently', () => {
    // 12:00 in Dhaka is 06:00Z: the profile depends on the zone, not the instant alone.
    assert.strictEqual(minutesSinceMidnightIn(at('2026-09-24T06:00:00Z')), 12 * 60);
    assert.strictEqual(minutesSinceMidnightIn(at('2026-09-24T06:00:00Z'), 'UTC'), 6 * 60);
  });
});

describe('isWithinRushHour', () => {
  const cases = [
    ['06:29', false],
    ['07:29', false],
    ['07:30', true],
    ['09:00', true],
    ['10:29', true],
    ['10:30', false],
    ['12:41', false],
    ['16:29', false],
    ['16:30', true],
    ['19:59', true],
    ['20:00', false],
    ['23:00', false],
  ];

  for (const [localTime, expected] of cases) {
    it(`treats ${localTime} in Asia/Dhaka as ${expected ? 'rush hour' : 'normal'}`, () => {
      const instant = at(`2026-09-24T${localTime}:00+06:00`);
      assert.strictEqual(isWithinRushHour(instant, WINDOWS), expected);
    });
  }

  it('covers the documented windows exactly once', () => {
    const samples = Array.from({ length: 24 * 60 }, (_value, minute) => {
      const hour = String(Math.floor(minute / 60)).padStart(2, '0');
      const minutes = String(minute % 60).padStart(2, '0');
      return { minute, rush: isWithinRushHour(at(`2026-09-24T${hour}:${minutes}:00+06:00`), WINDOWS) };
    });

    const first = samples.find((sample) => sample.rush).minute;
    const last = samples.filter((sample) => sample.rush).at(-1).minute;

    assert.strictEqual(first, 7 * 60 + 30);
    assert.strictEqual(last, 19 * 60 + 59);
    // 07:30-10:30 is 180 minutes, 16:30-20:00 is 210.
    assert.strictEqual(samples.filter((sample) => sample.rush).length, 180 + 210);
  });
});

describe('resolveTrafficProfile', () => {
  it('returns RUSH_HOUR for a Dhaka morning departure, however it is written', () => {
    // The same instant expressed with an offset and with Z must agree: the
    // profile depends on the instant, not the notation.
    const withOffset = resolveTrafficProfile(at('2026-09-24T08:41:00+06:00'), WINDOWS);
    const withZulu = resolveTrafficProfile(at('2026-09-24T02:41:00Z'), WINDOWS);

    assert.strictEqual(withOffset, TRAFFIC_PROFILE.RUSH_HOUR);
    assert.strictEqual(withZulu, TRAFFIC_PROFILE.RUSH_HOUR);
  });

  it('returns NORMAL outside both windows', () => {
    assert.strictEqual(
      resolveTrafficProfile(at('2026-09-24T06:00:00Z'), WINDOWS),
      TRAFFIC_PROFILE.NORMAL,
    );
    assert.strictEqual(
      resolveTrafficProfile(at('2026-09-24T22:00:00Z'), WINDOWS),
      TRAFFIC_PROFILE.NORMAL,
    );
  });
});
