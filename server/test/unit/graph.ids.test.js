import '../helpers/test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assignGraphEdgeIds, assignGraphNodeIds } from '../../src/db/seeds/graph-ids.js';

/**
 * Graph identifier assignment.
 *
 * pgRouting needs integer identifiers, and the seeder and the SQL backfill in
 * 06-pgrouting-routing.sql both have to agree on which integer belongs to which
 * code. These tests pin the JavaScript half of that rule; the integration suite
 * asserts that the database agrees with it.
 */

describe('assignGraphNodeIds', () => {
  it('ranks codes from 1 in ascending byte order', () => {
    const ids = assignGraphNodeIds(['vertex-b', 'vertex-a', 'vertex-c']);

    assert.strictEqual(ids.get('vertex-a'), 1);
    assert.strictEqual(ids.get('vertex-b'), 2);
    assert.strictEqual(ids.get('vertex-c'), 3);
  });

  it('does not depend on the order the codes are supplied in', () => {
    const codes = ['vertex-banani-road-11', 'vertex-gulshan-1-circle', 'vertex-mirpur-10'];
    const forward = assignGraphNodeIds(codes);
    const reversed = assignGraphNodeIds([...codes].reverse());

    assert.deepStrictEqual([...forward.entries()].sort(), [...reversed.entries()].sort());
  });

  it('sorts in byte order, where punctuation is not ignored', () => {
    // A locale collation such as en_US.UTF-8 ignores punctuation when comparing,
    // so "vertex-a_b" could sort before "vertex-a-b". COLLATE "C" (and
    // Array#sort) do not: "-" is 0x2D and "_" is 0x5F.
    const ids = assignGraphNodeIds(['vertex-a_b', 'vertex-a-b']);

    assert.strictEqual(ids.get('vertex-a-b'), 1);
    assert.strictEqual(ids.get('vertex-a_b'), 2);
  });

  it('gives a code appended last the next unused identifier', () => {
    const before = assignGraphNodeIds(['vertex-a', 'vertex-b']);
    const after = assignGraphNodeIds(['vertex-a', 'vertex-b', 'vertex-c']);

    assert.strictEqual(after.get('vertex-a'), before.get('vertex-a'));
    assert.strictEqual(after.get('vertex-b'), before.get('vertex-b'));
    assert.strictEqual(after.get('vertex-c'), 3);
  });

  it('produces one identifier per code and never repeats one', () => {
    const codes = ['vertex-a', 'vertex-b', 'vertex-c'];
    const values = [...assignGraphNodeIds(codes).values()];

    assert.strictEqual(new Set(values).size, codes.length);
  });
});

describe('assignGraphEdgeIds', () => {
  it('uses the same rule for edge codes', () => {
    const ids = assignGraphEdgeIds(['edge-b-to-c', 'edge-a-to-b']);

    assert.strictEqual(ids.get('edge-a-to-b'), 1);
    assert.strictEqual(ids.get('edge-b-to-c'), 2);
  });

  it('is deterministic, which is what keeps identifiers stable across seed runs', () => {
    const codes = ['edge-a-to-b', 'edge-b-to-a'];
    assert.deepStrictEqual([...assignGraphEdgeIds(codes)], [...assignGraphEdgeIds(codes)]);
  });
});
