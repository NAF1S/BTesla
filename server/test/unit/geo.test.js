import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DHAKA_BOUNDS,
  isWithinDhakaBounds,
  isValidLatitude,
  isValidLongitude,
  toLineStringWkt,
  toPointWkt,
} from '../../src/utils/geo.js';

/**
 * The geo helpers are the only place longitude-before-latitude is applied, so
 * these tests are the guard against the most expensive mistake in the whole
 * feature: a silently transposed coordinate.
 */

const DHAKA = { latitude: 23.7937, longitude: 90.4043 };

describe('toPointWkt', () => {
  it('writes longitude before latitude', () => {
    assert.strictEqual(toPointWkt(DHAKA), 'POINT(90.4043 23.7937)');
  });

  it('is not confusable with a positional pair', () => {
    // Passing the two numbers the other way round is impossible here, because
    // the helper only accepts a named pair.
    const swapped = { latitude: DHAKA.longitude, longitude: DHAKA.latitude };
    assert.strictEqual(toPointWkt(swapped), 'POINT(23.7937 90.4043)');
    assert.notStrictEqual(toPointWkt(swapped), toPointWkt(DHAKA));
  });
});

describe('toLineStringWkt', () => {
  it('writes each coordinate longitude first, in order', () => {
    const wkt = toLineStringWkt([
      DHAKA,
      { latitude: 23.7897, longitude: 90.4039 },
    ]);

    assert.strictEqual(wkt, 'LINESTRING(90.4043 23.7937, 90.4039 23.7897)');
  });

  it('rejects fewer than two coordinates', () => {
    assert.throws(() => toLineStringWkt([]), /at least two/i);
    assert.throws(() => toLineStringWkt([DHAKA]), /at least two/i);
    assert.throws(() => toLineStringWkt(undefined), /at least two/i);
  });
});

describe('coordinate validation', () => {
  it('accepts valid WGS84 values and rejects out-of-range ones', () => {
    assert.ok(isValidLatitude(0));
    assert.ok(isValidLatitude(-90));
    assert.ok(isValidLatitude(90));
    assert.ok(!isValidLatitude(90.1));
    assert.ok(!isValidLatitude(-90.1));
    assert.ok(!isValidLatitude(Number.NaN));
    assert.ok(!isValidLatitude('23.5'));

    assert.ok(isValidLongitude(180));
    assert.ok(isValidLongitude(-180));
    assert.ok(!isValidLongitude(180.1));
    assert.ok(!isValidLongitude(Number.POSITIVE_INFINITY));
  });

  it('bounds a point inside Dhaka and rejects one outside it', () => {
    assert.ok(isWithinDhakaBounds(DHAKA));
    assert.ok(isWithinDhakaBounds({ latitude: DHAKA_BOUNDS.minLatitude, longitude: DHAKA_BOUNDS.minLongitude }));

    // Uttara is in Dhaka; Chittagong is not; a swapped pair is not either.
    assert.ok(isWithinDhakaBounds({ latitude: 23.8676, longitude: 90.3932 }));
    assert.ok(!isWithinDhakaBounds({ latitude: 22.3569, longitude: 91.7832 }));
    assert.ok(!isWithinDhakaBounds({ latitude: DHAKA.longitude, longitude: DHAKA.latitude }));
  });
});
