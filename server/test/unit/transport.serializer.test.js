import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as dto from '../../src/serializers/transport.serializer.js';

/**
 * The DTO mappers are the only place where Prisma records become API payloads,
 * so these tests pin down three promises: camelCase shape, numbers instead of
 * Decimal values, and no internal audit columns.
 *
 * The inputs below mirror what Prisma actually returns, including nested
 * relations and decimal.js instances for NUMERIC columns.
 */

const TIMESTAMPS = { createdAt: new Date(), updatedAt: new Date() };

/** Values arrive from Prisma as decimal.js instances, which stringify like this. */
const decimal = (text) => text;

describe('toZoneDto', () => {
  it('keeps only the public fields', () => {
    const zone = dto.toZoneDto({ id: 'z1', code: 'banani', name: 'Banani', active: true, ...TIMESTAMPS });

    assert.deepStrictEqual(zone, { id: 'z1', code: 'banani', name: 'Banani' });
  });
});

describe('toStopDto', () => {
  it('flattens the zone relation and converts Decimal coordinates to numbers', () => {
    const stop = dto.toStopDto({
      id: 's1',
      code: 'banani-road-11',
      name: 'Banani Road 11',
      latitude: decimal('23.793700'),
      longitude: decimal('90.404300'),
      zoneId: 'z1',
      zone: { code: 'banani' },
      active: true,
      ...TIMESTAMPS,
    });

    assert.deepStrictEqual(stop, {
      id: 's1',
      code: 'banani-road-11',
      name: 'Banani Road 11',
      zoneCode: 'banani',
      latitude: 23.7937,
      longitude: 90.4043,
    });
    assert.strictEqual(typeof stop.latitude, 'number');
  });

  it('keeps missing coordinates as null', () => {
    const stop = dto.toStopDto({
      id: 's2',
      code: 'somewhere',
      name: 'Somewhere',
      latitude: null,
      longitude: null,
      zone: { code: 'banani' },
    });

    assert.strictEqual(stop.latitude, null);
    assert.strictEqual(stop.longitude, null);
  });

  it('tolerates a stop whose zone relation was not loaded', () => {
    const stop = dto.toStopDto({ id: 's3', code: 'orphan', name: 'Orphan', latitude: null, longitude: null });

    assert.strictEqual(stop.zoneCode, null);
  });
});

describe('toCorridorDetailDto', () => {
  it('preserves the given order and exposes numeric positions', () => {
    const detail = dto.toCorridorDetailDto(
      { id: 'c1', code: 'northbound-demo', name: 'Northbound', active: true, ...TIMESTAMPS },
      [
        {
          position: 1,
          stop: {
            id: 's1',
            code: 'banani-road-11',
            name: 'A',
            zone: { code: 'banani' },
            latitude: null,
            longitude: null,
          },
        },
        {
          position: 2,
          stop: {
            id: 's2',
            code: 'gulshan-1',
            name: 'B',
            zone: { code: 'gulshan' },
            latitude: decimal('1.5'),
            longitude: null,
          },
        },
      ],
    );

    assert.deepStrictEqual(detail, {
      id: 'c1',
      code: 'northbound-demo',
      name: 'Northbound',
      stops: [
        {
          position: 1,
          id: 's1',
          code: 'banani-road-11',
          name: 'A',
          zoneCode: 'banani',
          latitude: null,
          longitude: null,
        },
        {
          position: 2,
          id: 's2',
          code: 'gulshan-1',
          name: 'B',
          zoneCode: 'gulshan',
          latitude: 1.5,
          longitude: null,
        },
      ],
    });
  });
});

describe('toCorridorMatchDto', () => {
  it('nests the corridor and converts positions', () => {
    const match = dto.toCorridorMatchDto({
      corridor: { id: 'c1', code: 'northbound-demo', name: 'Northbound' },
      pickupPosition: 1,
      dropoffPosition: 6,
    });

    assert.deepStrictEqual(match, {
      corridor: { id: 'c1', code: 'northbound-demo', name: 'Northbound' },
      pickupPosition: 1,
      dropoffPosition: 6,
    });
  });
});

describe('toTravelEstimateDto', () => {
  it('converts money and distance without leaking ids or timestamps', () => {
    const estimate = dto.toTravelEstimateDto({
      id: 'e1',
      estimatedMinutes: 18,
      estimatedDistanceKm: decimal('5.40'),
      baseFare: decimal('165.00'),
      currency: 'BDT',
      fromStopId: 's1',
      toStopId: 's4',
      fromStop: { code: 'banani-road-11', name: 'Banani Road 11' },
      toStop: { code: 'gulshan-1', name: 'Gulshan 1' },
      ...TIMESTAMPS,
    });

    assert.deepStrictEqual(estimate, {
      fromStop: { code: 'banani-road-11', name: 'Banani Road 11' },
      toStop: { code: 'gulshan-1', name: 'Gulshan 1' },
      estimatedMinutes: 18,
      estimatedDistanceKm: 5.4,
      baseFare: 165,
      currency: 'BDT',
    });
    assert.strictEqual(typeof estimate.baseFare, 'number');
  });
});
