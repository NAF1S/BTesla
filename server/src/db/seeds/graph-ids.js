/**
 * Assignment of the integer graph identifiers pgRouting needs.
 *
 * ---------------------------------------------------------------------------
 * ONE RULE, TWO IMPLEMENTATIONS
 * ---------------------------------------------------------------------------
 * Both this module and server/db/06-pgrouting-routing.sql answer the same
 * question -- "which integer belongs to this code?" -- and they must agree, or a
 * database built from scratch would disagree with one migrated from an earlier
 * phase. The rule both implement is:
 *
 *     rank the codes ascending in byte order, counting from 1
 *
 * `Array#sort` with no comparator compares UTF-16 code units, which for the
 * ASCII-only codes these tables allow (`^[a-z0-9][a-z0-9_-]{0,63}$`) is exactly
 * byte order; the SQL side says so explicitly with `COLLATE "C"`. A collation
 * such as en_US.UTF-8 would instead ignore punctuation, so it is never used.
 *
 * The identifiers are assigned once and are immutable in the database (a trigger
 * in 06-pgrouting-routing.sql rejects an UPDATE), because a route result is a
 * list of edge identifiers: reassigning one would repoint an existing route.
 * That is also why the seeder never rewrites them on conflict.
 */

/**
 * Maps each code to its 1-based rank in ascending byte order.
 *
 * Pure and deterministic: the same codes always produce the same identifiers,
 * whatever order they are supplied in, and a code appended after the last one
 * takes the next number without disturbing the others.
 */
const rankByCode = (codes) => {
  const ranked = [...codes].sort();
  return new Map(ranked.map((code, index) => [code, index + 1]));
};

/** Graph node identifiers for routing vertex codes (`vertex-<point code>`). */
export const assignGraphNodeIds = (vertexCodes) => rankByCode(vertexCodes);

/** Graph edge identifiers for routing edge codes (`edge-<from>-to-<to>`). */
export const assignGraphEdgeIds = (edgeCodes) => rankByCode(edgeCodes);
