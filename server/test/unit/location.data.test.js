import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEMO_SPEED_KMH, LOCATION_EDGES, LOCATION_ZONES } from '../../src/db/seeds/location.data.js';
import {
  allSeedPoints,
  assertSeedDataIsCoherent,
  edgeCode,
  vertexCode,
} from '../../src/db/seeds/location.seed.js';
import { DHAKA_BOUNDS, isWithinDhakaBounds, isValidLatitude, isValidLongitude } from '../../src/utils/geo.js';

/**
 * The seed data file is the single source of truth for the demo map, so these
 * tests pin down its shape without touching a database. The seeder asserts the
 * same invariants at run time; this is the faster feedback loop for a typo.
 */

const points = allSeedPoints();

describe('location seed data shape', () => {
  it('covers at least 15 zones with at least three points each', () => {
    assert.ok(LOCATION_ZONES.length >= 15, `expected >= 15 zones, got ${LOCATION_ZONES.length}`);

    for (const zone of LOCATION_ZONES) {
      assert.ok(
        zone.points.length >= 3,
        `zone "${zone.code}" has only ${zone.points.length} point(s)`,
      );
    }

    assert.ok(points.length >= 45, `expected >= 45 points, got ${points.length}`);
  });

  it('uses globally unique, well-formed codes', () => {
    const zoneCodes = LOCATION_ZONES.map((zone) => zone.code);
    assert.strictEqual(new Set(zoneCodes).size, zoneCodes.length, 'zone codes must be unique');

    const pointCodes = points.map((point) => point.code);
    assert.strictEqual(new Set(pointCodes).size, pointCodes.length, 'point codes must be globally unique');

    const pattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    for (const code of [...zoneCodes, ...pointCodes]) {
      assert.match(code, pattern, `code "${code}" does not match the project code format`);
    }
  });

  it('gives every zone a unique display name', () => {
    const names = LOCATION_ZONES.map((zone) => zone.name);
    assert.strictEqual(new Set(names).size, names.length);
  });

  it('passes its own coherence assertions', () => {
    assert.doesNotThrow(() => assertSeedDataIsCoherent());
  });
});

describe('location seed coordinates', () => {
  it('uses valid WGS84 coordinates inside the configured Dhaka bounds', () => {
    for (const point of points) {
      assert.ok(isValidLatitude(point.latitude), `${point.code} latitude is not a valid WGS84 value`);
      assert.ok(isValidLongitude(point.longitude), `${point.code} longitude is not a valid WGS84 value`);
      assert.ok(
        isWithinDhakaBounds(point),
        `${point.code} (${point.latitude}, ${point.longitude}) is outside Dhaka`,
      );
    }
  });

  it('never repeats a coordinate inside one zone', () => {
    for (const zone of LOCATION_ZONES) {
      const seen = new Set(zone.points.map((point) => `${point.latitude},${point.longitude}`));
      assert.strictEqual(
        seen.size,
        zone.points.length,
        `zone "${zone.code}" has two points at the same coordinates`,
      );
    }
  });

  it('places every point north-east of the bounds origin, i.e. not swapped', () => {
    // A latitude/longitude swap would still be valid WGS84 but would land the
    // point outside Dhaka, which is exactly what the bounds exist to catch.
    for (const point of points) {
      assert.ok(point.latitude > 23 && point.latitude < 24, `${point.code} latitude looks swapped`);
      assert.ok(point.longitude > 90 && point.longitude < 91, `${point.code} longitude looks swapped`);
    }
    assert.ok(DHAKA_BOUNDS.minLatitude < DHAKA_BOUNDS.maxLatitude);
    assert.ok(DHAKA_BOUNDS.minLongitude < DHAKA_BOUNDS.maxLongitude);
  });
});

describe('routing graph seed data', () => {
  it('derives stable vertex and edge codes', () => {
    assert.strictEqual(vertexCode('banani-road-11'), 'vertex-banani-road-11');
    assert.strictEqual(
      edgeCode('banani-road-11', 'banani-kakoli'),
      'edge-banani-road-11-to-banani-kakoli',
    );
  });

  it('connects every point to the graph and has no self-loops', () => {
    const codes = new Set(points.map((point) => point.code));

    for (const edge of LOCATION_EDGES) {
      assert.ok(codes.has(edge.from), `edge ${edge.from} -> ${edge.to} has an unknown source`);
      assert.ok(codes.has(edge.to), `edge ${edge.from} -> ${edge.to} has an unknown target`);
      assert.notStrictEqual(edge.from, edge.to, `edge ${edge.from} -> ${edge.to} is a self-loop`);
    }

    const touched = new Set(LOCATION_EDGES.flatMap((edge) => [edge.from, edge.to]));
    for (const code of codes) {
      assert.ok(touched.has(code), `point "${code}" has no edge and would be isolated`);
    }
  });

  it('chains the three points of every zone together', () => {
    const pairs = new Set(LOCATION_EDGES.map((edge) => `${edge.from}|${edge.to}`));

    for (const zone of LOCATION_ZONES) {
      const [first, second, third] = zone.points.map((point) => point.code);
      assert.ok(pairs.has(`${first}|${second}`), `zone "${zone.code}" is missing ${first} -> ${second}`);
      assert.ok(pairs.has(`${second}|${third}`), `zone "${zone.code}" is missing ${second} -> ${third}`);
    }
  });

  it('mixes one-way and bidirectional edges', () => {
    const oneWay = LOCATION_EDGES.filter((edge) => edge.bidirectional === false);
    const bothWays = LOCATION_EDGES.filter((edge) => edge.bidirectional !== false);

    assert.ok(oneWay.length > 0, 'the seed should include at least one one-way edge');
    assert.ok(bothWays.length > 0, 'the seed should include at least one bidirectional edge');
    assert.ok(oneWay.length < bothWays.length, 'most edges should be two-way');
  });

  it('uses positive fare weights and documents demo speeds', () => {
    for (const edge of LOCATION_EDGES) {
      const fareWeight = edge.fareWeight ?? 1;
      assert.ok(fareWeight > 0, `edge ${edge.from} -> ${edge.to} has a non-positive fareWeight`);
    }

    // Rush hour must be the slower of the two, or every duration check breaks.
    assert.ok(DEMO_SPEED_KMH.rushHour < DEMO_SPEED_KMH.normal);
  });
});
