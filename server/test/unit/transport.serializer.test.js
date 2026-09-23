import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as dto from '../../src/serializers/transport.serializer.js';

/**
 * The DTO mappers are the only place where database rows become API payloads,
 * so these tests pin down three promises: camelCase shape, numbers instead of
 * NUMERIC strings, and no internal audit columns.
 */

const TIMESTAMPS = { created_at: new Date(), updated_at: new Date() };

describe('toZoneDto', () => {
  it('keeps only the public fields', () => {
    const zone = dto.toZoneDto({ id: 'z1', code: 'banani', name: 'Banani', active: true, ...TIMESTAMPS });

    assert.deepStrictEqual(zone, { id: 'z1', code: 'banani', name: 'Banani' });
  });
});

describe('toStopDto', () => {
  it('maps snake_case and converts NUMERIC coordinates to numbers', () => {
    const stop = dto.toStopDto({
      id: 's1',
      code: 'banani-road-11',
      name: 'Banani Road 11',
      latitude: '23.793700',
      longitude: '90.404300',
      zone_code: 'banani',
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
      zone_code: 'banani',
    });

    assert.strictEqual(stop.latitude, null);
    assert.strictEqual(stop.longitude, null);
  });
});

describe('toCorridorDetailDto', () => {
  it('preserves the given order and exposes numeric positions', () => {
    const detail = dto.toCorridorDetailDto(
      { id: 'c1', code: 'northbound-demo', name: 'Northbound', active: true, ...TIMESTAMPS },
      [
        { position: 1, id: 's1', code: 'banani-road-11', name: 'A', zone_code: 'banani', latitude: null, longitude: null },
        { position: 2, id: 's2', code: 'gulshan-1', name: 'B', zone_code: 'gulshan', latitude: '1.5', longitude: null },
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
      id: 'c1',
      code: 'northbound-demo',
      name: 'Northbound',
      pickup_position: 1,
      dropoff_position: 6,
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
      estimated_minutes: 18,
      estimated_distance_km: '5.40',
      base_fare: '165.00',
      currency: 'BDT',
      from_stop_code: 'banani-road-11',
      from_stop_name: 'Banani Road 11',
      to_stop_code: 'gulshan-1',
      to_stop_name: 'Gulshan 1',
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
