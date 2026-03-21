-- Add transfers table to support GTFS transfers.txt data
-- Run this against your connext database

CREATE TABLE IF NOT EXISTS gtfs_transfers (
    system_id          TEXT NOT NULL,
    from_stop_id       TEXT NOT NULL,
    to_stop_id         TEXT NOT NULL,
    transfer_type      INTEGER DEFAULT 0,
    min_transfer_time  INTEGER,             -- seconds
    from_route_id      TEXT DEFAULT '',
    to_route_id        TEXT DEFAULT '',
    from_trip_id       TEXT,
    to_trip_id         TEXT,
    PRIMARY KEY (system_id, from_stop_id, to_stop_id, from_route_id, to_route_id)
);

CREATE INDEX IF NOT EXISTS idx_transfers_from
    ON gtfs_transfers(system_id, from_stop_id);

CREATE INDEX IF NOT EXISTS idx_transfers_to
    ON gtfs_transfers(system_id, to_stop_id);

-- Also add pathways table for detailed station layout data (GTFS pathways.txt)
-- This provides stair/elevator/walkway info when agencies publish it
CREATE TABLE IF NOT EXISTS gtfs_pathways (
    system_id          TEXT NOT NULL,
    pathway_id         TEXT NOT NULL,
    from_stop_id       TEXT NOT NULL,
    to_stop_id         TEXT NOT NULL,
    pathway_mode       INTEGER NOT NULL,     -- 1=walkway, 2=stairs, 3=moving sidewalk, 4=escalator, 5=elevator, 6=fare gate, 7=exit gate
    is_bidirectional   INTEGER DEFAULT 1,
    traversal_time     INTEGER,              -- seconds
    length             NUMERIC(10, 2),       -- meters
    stair_count        INTEGER,
    max_slope          NUMERIC(5, 4),
    min_width          NUMERIC(5, 2),        -- meters
    signposted_as      TEXT,
    reversed_signposted_as TEXT,
    PRIMARY KEY (system_id, pathway_id)
);

CREATE INDEX IF NOT EXISTS idx_pathways_from
    ON gtfs_pathways(system_id, from_stop_id);

-- Levels table for multi-level station modeling
CREATE TABLE IF NOT EXISTS gtfs_levels (
    system_id    TEXT NOT NULL,
    level_id     TEXT NOT NULL,
    level_index  NUMERIC(5, 2) NOT NULL,
    level_name   TEXT,
    PRIMARY KEY (system_id, level_id)
);
