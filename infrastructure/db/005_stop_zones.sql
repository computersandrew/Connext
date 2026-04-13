-- 005_stop_zones.sql
-- Adds zone_id to gtfs_stops for zone-based fare lookup (SEPTA Regional Rail, etc.)
-- zone_id mirrors the GTFS stops.txt zone_id field: e.g. CC, 1N, 2S, NJ

ALTER TABLE gtfs_stops ADD COLUMN IF NOT EXISTS zone_id TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_gtfs_stops_zone
  ON gtfs_stops (system_id, zone_id)
  WHERE zone_id IS NOT NULL AND zone_id != '';
