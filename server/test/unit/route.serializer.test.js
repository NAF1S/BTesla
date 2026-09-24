import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assembleRouteCoordinates } from '../../src/services/routing.service.js';
import { toRouteEstimateDto } from '../../src/serializers/route.serializer.js';

/**
 * Route DTO formatting and geometry assembly.
 *
 * The estimate used here is a hand-built fixture rather than a database result,
 * so the arithmetic can be asserted exactly -- and so this stays a unit test.
 */

const estimateFixture = () => ({
  origin: { code: 'banani-road-11', name: 'Banani Road 11' },
  destination: { code: 'mohakhali-bus-terminal', name: 'Mohakhali Bus Terminal' },
  departureAt: new Date('2026-09-24T02:41:00.000Z'),
  trafficProfile: 'RUSH_HOUR',
  distanceMeters: 4200,
  durationSeconds: 840,
  // Deliberately not a straight line: the merged line must keep leg order.
  geometry: {
    type: 'LineString',
    coordinates: [
      [90.4043, 23.7937],
      [90.4006, 23.774],
      [90.4006, 23.7741],
    ],
  },
  legs: [
    {
      sequence: 1,
      edgeCode: 'edge-banani-road-11-to-banani-kakoli',
      direction: 'FORWARD',
      distanceMeters: 900,
      durationSeconds: 180,
    },
    {
      sequence: 2,
      edgeCode: 'edge-banani-kakoli-to-banani-chairman-bari',
      direction: 'BACKWARD',
      distanceMeters: 3300,
      durationSeconds: 660,
    },
  ],
});

describe('toRouteEstimateDto', () => {
  it('returns only the documented fields', () => {
    const dto = toRouteEstimateDto(estimateFixture());

    assert.deepStrictEqual(Object.keys(dto).sort(), [
      'departureAt',
      'destination',
      'distanceKilometers',
      'distanceMeters',
      'durationMinutes',
      'durationSeconds',
      'estimatedArrivalAt',
      'geometry',
      'legs',
      'origin',
      'trafficProfile',
    ]);
  });

  it('contains no fare, price, pool or ride field', () => {
    const serialized = JSON.stringify(toRouteEstimateDto(estimateFixture()));

    for (const forbidden of ['fare', 'price', 'cost', 'amount', 'pool', 'ride', 'match', 'seat']) {
      assert.ok(
        !serialized.toLowerCase().includes(forbidden),
        `a route estimate must not contain "${forbidden}"`,
      );
    }
  });

  it('returns UTC timestamps and an arrival derived from the duration', () => {
    const dto = toRouteEstimateDto(estimateFixture());

    assert.strictEqual(dto.departureAt, '2026-09-24T02:41:00.000Z');
    assert.strictEqual(dto.estimatedArrivalAt, '2026-09-24T02:55:00.000Z');
    assert.strictEqual(
      new Date(dto.estimatedArrivalAt).getTime() - new Date(dto.departureAt).getTime(),
      dto.durationSeconds * 1000,
    );
  });

  it('reports distance in both units, and duration in both units', () => {
    const dto = toRouteEstimateDto(estimateFixture());

    assert.strictEqual(dto.distanceMeters, 4200);
    assert.strictEqual(dto.distanceKilometers, 4.2);
    assert.strictEqual(dto.durationSeconds, 840);
    assert.strictEqual(dto.durationMinutes, 14);
  });

  it('rounds kilometres to the metre instead of leaking float noise', () => {
    const dto = toRouteEstimateDto({ ...estimateFixture(), distanceMeters: 2214 });

    assert.strictEqual(dto.distanceKilometers, 2.214);
  });

  it('keeps the legs in order and drops their coordinates', () => {
    const dto = toRouteEstimateDto(estimateFixture());

    assert.deepStrictEqual(
      dto.legs.map((leg) => leg.sequence),
      [1, 2],
    );
    assert.strictEqual(dto.legs[1].direction, 'BACKWARD');
    assert.deepStrictEqual(Object.keys(dto.legs[0]).sort(), [
      'direction',
      'distanceMeters',
      'durationSeconds',
      'edgeCode',
      'sequence',
    ]);
  });

  it('passes the geometry through as GeoJSON without adding anything', () => {
    const dto = toRouteEstimateDto(estimateFixture());

    assert.strictEqual(dto.geometry.type, 'LineString');
    assert.deepStrictEqual(dto.geometry.coordinates, estimateFixture().geometry.coordinates);
  });
});

describe('assembleRouteCoordinates', () => {
  it('joins legs in travel order, dropping the position they share', () => {
    const coordinates = assembleRouteCoordinates([
      {
        coordinates: [
          [90.1, 23.1],
          [90.2, 23.2],
        ],
      },
      {
        coordinates: [
          [90.2, 23.2],
          [90.3, 23.3],
        ],
      },
    ]);

    assert.deepStrictEqual(coordinates, [
      [90.1, 23.1],
      [90.2, 23.2],
      [90.3, 23.3],
    ]);
  });

  it('collapses an exactly repeated position instead of emitting a zero-length step', () => {
    const coordinates = assembleRouteCoordinates([
      {
        coordinates: [
          [90.1, 23.1],
          [90.1, 23.1],
          [90.2, 23.2],
        ],
      },
    ]);

    assert.deepStrictEqual(coordinates, [
      [90.1, 23.1],
      [90.2, 23.2],
    ]);
  });

  it('preserves the direction a leg was traversed in', () => {
    // A backwards leg arrives already reversed; assembly must not reorder it.
    const coordinates = assembleRouteCoordinates([
      { coordinates: [[90.2, 23.2], [90.1, 23.1]] },
      { coordinates: [[90.1, 23.1], [90.0, 23.0]] },
    ]);

    assert.deepStrictEqual(coordinates, [
      [90.2, 23.2],
      [90.1, 23.1],
      [90.0, 23.0],
    ]);
  });

  it('returns the single leg unchanged', () => {
    const coordinates = assembleRouteCoordinates([
      {
        coordinates: [
          [90.4043, 23.7937],
          [90.4006, 23.774],
        ],
      },
    ]);

    assert.deepStrictEqual(coordinates, [
      [90.4043, 23.7937],
      [90.4006, 23.774],
    ]);
  });
});
