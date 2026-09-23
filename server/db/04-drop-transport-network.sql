-- ---------------------------------------------------------------------------
-- Removes the superseded transport-network schema.
--
-- The previous location implementation described pickup/drop-off stops with
-- plain NUMERIC latitude/longitude columns, plus corridors, ordered corridor
-- stops and directional travel estimates. The PostGIS location foundation
-- (05-postgis-location.sql) replaces all of it.
--
-- Why a forward migration rather than simply deleting the old file: that file
-- may already have been applied, so a database in the wild still holds these
-- tables. Dropping them here cleans up such a database without rewriting
-- migration history. The old file is deleted as well, so a fresh database never
-- creates these tables in the first place.
--
-- Order matters: dependent tables before the tables they reference.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS corridor_stops;
DROP TABLE IF EXISTS travel_estimates;
DROP TABLE IF EXISTS corridors;
DROP TABLE IF EXISTS stops;
DROP TABLE IF EXISTS zones;
