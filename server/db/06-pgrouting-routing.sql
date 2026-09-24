-- ---------------------------------------------------------------------------
-- Routing milestone: pgRouting, plus the integer graph identifiers it needs.
--
--   1. extension:      postgis (05) + pgrouting (here)
--   2. identifiers:    routing_vertices.graph_node_id  BIGINT
--                      routing_edges.graph_edge_id     BIGINT
--   3. guards:         graph identifiers are immutable once written
--
-- ---------------------------------------------------------------------------
-- WHY EXTRA IDENTIFIERS
-- ---------------------------------------------------------------------------
-- pgRouting requires integer graph identifiers ("id, source, target: any
-- positive number"). This project keys its tables on UUIDs, which pgRouting
-- cannot use, so each vertex and edge carries an additional, immutable BIGINT
-- alongside the UUID primary key:
--
--   * the UUID `id` stays the public/domain identifier -- nothing is renamed or
--     replaced, and every foreign key still points at the UUID;
--   * graph_node_id / graph_edge_id are the *graph* identifiers, used only as
--     the `source` / `target` / `id` columns handed to pgr_dijkstra.
--
-- Their values never change: they are written once and a trigger rejects any
-- later UPDATE. That matters because a route result is a list of graph edge
-- identifiers -- if an identifier could be reassigned, a stored route would
-- silently point at different edges.
--
-- ---------------------------------------------------------------------------
-- THE ASSIGNMENT RULE (deterministic, and mirrored by the seeder)
-- ---------------------------------------------------------------------------
-- To keep a fresh database and an already-seeded database identical, the rule
-- is fixed and code-derived rather than insertion-ordered:
--
--     rank the codes ascending in byte order (COLLATE "C"), 1-based
--
--   routing_vertices: ORDER BY code          -> vertex-<point code>
--   routing_edges:    ORDER BY code          -> edge-<from>-to-<to>
--
-- server/src/db/seeds/graph-ids.js applies the same rule in JavaScript (default
-- Array#sort compares UTF-16 code units, which is byte order for the
-- ASCII-only codes these constraints allow), so a database migrated from an
-- earlier phase and a database built from scratch agree exactly.
-- `npm run db:seed` writes the identifiers explicitly; the backfill below only
-- covers rows that already existed before this migration.
--
-- Idempotent: this file is re-applied by `npm run db:migrate`.
--
-- Privileges: CREATE EXTENSION needs a role allowed to create extensions. The
-- compose database runs as the `postgres` superuser, so this succeeds out of
-- the box; on a managed service the extension is usually enabled from the
-- provider's console (or by a superuser) and this statement then becomes a
-- no-op. Verify with:
--
--   SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'pgrouting');
--
-- ---------------------------------------------------------------------------

-- 1. pgRouting ---------------------------------------------------------------
--
-- Provided by the docker/db/Dockerfile image (PostGIS 17-3.5 + pgRouting 3.8).
-- Rebuild the container after changing that Dockerfile:
--
--   docker compose up -d --build db
CREATE EXTENSION IF NOT EXISTS pgrouting;

-- 2. routing_vertices.graph_node_id -----------------------------------------
--
-- Added nullable, backfilled, then tightened, so the statement works both on an
-- empty table (a fresh volume) and on one that already holds the seeded graph.
ALTER TABLE routing_vertices ADD COLUMN IF NOT EXISTS graph_node_id BIGINT;

WITH ranked AS (
  SELECT id, row_number() OVER (ORDER BY code COLLATE "C") AS graph_node_id
    FROM routing_vertices
)
UPDATE routing_vertices v
   SET graph_node_id = ranked.graph_node_id
  FROM ranked
 WHERE ranked.id = v.id
   AND v.graph_node_id IS NULL;

ALTER TABLE routing_vertices ALTER COLUMN graph_node_id SET NOT NULL;

ALTER TABLE routing_vertices DROP CONSTRAINT IF EXISTS routing_vertices_graph_node_id_unique;
ALTER TABLE routing_vertices
  ADD CONSTRAINT routing_vertices_graph_node_id_unique UNIQUE (graph_node_id);

-- pgRouting rejects zero and negative identifiers, so they are refused here too
-- rather than surfacing later as an obscure routing failure.
ALTER TABLE routing_vertices DROP CONSTRAINT IF EXISTS routing_vertices_graph_node_id_positive;
ALTER TABLE routing_vertices
  ADD CONSTRAINT routing_vertices_graph_node_id_positive CHECK (graph_node_id > 0);

-- The identifier has to exist, but it does not have to be chosen by hand. A
-- sequence supplies one for an insert that does not name one (a fixture, a
-- hand-written row), while the seeder keeps supplying its own: those values must
-- match the backfill above so that a fresh database and a migrated one agree.
--
-- setval puts the sequence above the highest identifier already present, so the
-- next generated value cannot collide with a seeded vertex. The seeder performs
-- the same resync once it has written the graph.
CREATE SEQUENCE IF NOT EXISTS routing_vertices_graph_node_id_seq;
ALTER SEQUENCE routing_vertices_graph_node_id_seq OWNED BY routing_vertices.graph_node_id;
ALTER TABLE routing_vertices
  ALTER COLUMN graph_node_id SET DEFAULT nextval('routing_vertices_graph_node_id_seq');

SELECT setval(
  'routing_vertices_graph_node_id_seq',
  GREATEST(coalesce((SELECT max(graph_node_id) FROM routing_vertices), 0), 1),
  coalesce((SELECT max(graph_node_id) FROM routing_vertices), 0) > 0
);

COMMENT ON COLUMN routing_vertices.graph_node_id IS
  'Integer graph identifier used as pgr_dijkstra''s source/target. Immutable; ranked from code in byte order.';

-- 3. routing_edges.graph_edge_id --------------------------------------------
--
-- `id` in pgRouting's edge query, and the value pgr_dijkstra reports back in its
-- `edge` column -- which is how a returned path is mapped to RoutingEdge rows.
ALTER TABLE routing_edges ADD COLUMN IF NOT EXISTS graph_edge_id BIGINT;

WITH ranked AS (
  SELECT id, row_number() OVER (ORDER BY code COLLATE "C") AS graph_edge_id
    FROM routing_edges
)
UPDATE routing_edges e
   SET graph_edge_id = ranked.graph_edge_id
  FROM ranked
 WHERE ranked.id = e.id
   AND e.graph_edge_id IS NULL;

ALTER TABLE routing_edges ALTER COLUMN graph_edge_id SET NOT NULL;

ALTER TABLE routing_edges DROP CONSTRAINT IF EXISTS routing_edges_graph_edge_id_unique;
ALTER TABLE routing_edges
  ADD CONSTRAINT routing_edges_graph_edge_id_unique UNIQUE (graph_edge_id);

ALTER TABLE routing_edges DROP CONSTRAINT IF EXISTS routing_edges_graph_edge_id_positive;
ALTER TABLE routing_edges
  ADD CONSTRAINT routing_edges_graph_edge_id_positive CHECK (graph_edge_id > 0);

CREATE SEQUENCE IF NOT EXISTS routing_edges_graph_edge_id_seq;
ALTER SEQUENCE routing_edges_graph_edge_id_seq OWNED BY routing_edges.graph_edge_id;
ALTER TABLE routing_edges
  ALTER COLUMN graph_edge_id SET DEFAULT nextval('routing_edges_graph_edge_id_seq');

SELECT setval(
  'routing_edges_graph_edge_id_seq',
  GREATEST(coalesce((SELECT max(graph_edge_id) FROM routing_edges), 0), 1),
  coalesce((SELECT max(graph_edge_id) FROM routing_edges), 0) > 0
);

COMMENT ON COLUMN routing_edges.graph_edge_id IS
  'Integer graph identifier used as pgr_dijkstra''s id and returned as its `edge`. Immutable; ranked from code in byte order.';

-- The unique constraints above index both graph identifiers, which is what the
-- "load this path's edges in one query" lookup uses. The routing edge query
-- itself filters on `active` and joins routing_vertices on its UUID primary key,
-- so the indexes created in 05-postgis-location.sql
-- (source_vertex_id, target_vertex_id, active) stay the ones that matter there.

-- 4. Immutability ------------------------------------------------------------
--
-- The column name is passed as a trigger argument so one function serves both
-- tables. `BEFORE UPDATE OF <column>` means the check only runs when a statement
-- actually tries to write the column.
CREATE OR REPLACE FUNCTION prevent_graph_identifier_change() RETURNS trigger AS $$
BEGIN
  IF to_jsonb(NEW) -> TG_ARGV[0] IS DISTINCT FROM to_jsonb(OLD) -> TG_ARGV[0] THEN
    RAISE EXCEPTION '% on %.% is immutable',
      TG_ARGV[0], TG_TABLE_NAME, TG_ARGV[0]
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS routing_vertices_graph_node_id_immutable ON routing_vertices;
CREATE TRIGGER routing_vertices_graph_node_id_immutable
  BEFORE UPDATE OF graph_node_id ON routing_vertices
  FOR EACH ROW EXECUTE FUNCTION prevent_graph_identifier_change('graph_node_id');

DROP TRIGGER IF EXISTS routing_edges_graph_edge_id_immutable ON routing_edges;
CREATE TRIGGER routing_edges_graph_edge_id_immutable
  BEFORE UPDATE OF graph_edge_id ON routing_edges
  FOR EACH ROW EXECUTE FUNCTION prevent_graph_identifier_change('graph_edge_id');
