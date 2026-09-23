import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toPointDto, toZoneDto } from '../../src/serializers/location.serializer.js';

/**
 * The DTO mappers are the boundary between a raw SQL row and the API, so these
 * tests pin down two promises: only whitelisted fields survive, and coordinates
 * come back as numbers rather than the driver's string representation.
 */

/** Every key appearing anywhere in the payload. */
const allKeys = (value, found = []) => {
  if (value === null || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    found.push(key);
    allKeys(child, found);
  }
  return found;
};

describe('toZoneDto', () => {
  it('exposes only the public fields, with numeric coordinates', () => {
    const dto = toZoneDto({
      id: 'z1',
      code: 'banani',
      name: 'Banani',
      latitude: '23.793700',
      longitude: '90.404300',
      active: true,
      created_at: new Date(),
      updated_at: new Date(),
    });

    assert.deepStrictEqual(dto, {
      id: 'z1',
      code: 'banani',
      name: 'Banani',
      latitude: 23.7937,
      longitude: 90.4043,
    });
    assert.strictEqual(typeof dto.latitude, 'number');
    assert.ok(!allKeys(dto).some((key) => ['active', 'created_at', 'updated_at'].includes(key)));
  });
});

describe('toPointDto', () => {
  it('maps snake_case zone_code to zoneCode and keeps coordinates numeric', () => {
    const dto = toPointDto({
      id: 'p1',
      code: 'banani-road-11',
      name: 'Banani Road 11',
      zone_code: 'banani',
      latitude: '23.793700',
      longitude: '90.404300',
      active: true,
    });

    assert.deepStrictEqual(dto, {
      id: 'p1',
      code: 'banani-road-11',
      name: 'Banani Road 11',
      zoneCode: 'banani',
      latitude: 23.7937,
      longitude: 90.4043,
    });
  });

  it('never leaks routing columns such as a vertex id', () => {
    const dto = toPointDto({
      id: 'p1',
      code: 'banani-road-11',
      name: 'Banani Road 11',
      zone_code: 'banani',
      latitude: 23.7937,
      longitude: 90.4043,
      routing_vertex_id: 'v1',
      active: true,
    });

    assert.ok(!allKeys(dto).includes('routing_vertex_id'), 'the vertex id must not be exposed');
    assert.ok(!allKeys(dto).includes('routingVertexId'));
  });
});
