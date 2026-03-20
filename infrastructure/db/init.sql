-- Connext database initialization
-- Run automatically by Docker on first start

-- Static GTFS tables (populated by import script)
CREATE TABLE IF NOT EXISTS gtfs_routes (
    system_id       TEXT NOT NULL,
    route_id        TEXT NOT NULL,
    route_short_name TEXT,
    route_long_name TEXT,
    route_color     TEXT,
    route_type      INTEGER,
    PRIMARY KEY (system_id, route_id)
);

CREATE TABLE IF NOT EXISTS gtfs_stops (
    system_id   TEXT NOT NULL,
    stop_id     TEXT NOT NULL,
    stop_name   TEXT,
    stop_lat    NUMERIC(10, 6),
    stop_lon    NUMERIC(10, 6),
    parent_station TEXT,
    PRIMARY KEY (system_id, stop_id)
);

CREATE TABLE IF NOT EXISTS gtfs_trips (
    system_id    TEXT NOT NULL,
    trip_id      TEXT NOT NULL,
    route_id     TEXT NOT NULL,
    direction_id INTEGER,
    trip_headsign TEXT,
    service_id   TEXT,
    PRIMARY KEY (system_id, trip_id)
);

-- Historical delay data (for probability engine)
CREATE TABLE IF NOT EXISTS delay_history (
    system_id   TEXT NOT NULL,
    stop_id     TEXT NOT NULL,
    route_id    TEXT NOT NULL,
    hour_bucket INTEGER NOT NULL,     -- 0-23
    day_type    TEXT NOT NULL,         -- 'weekday' or 'weekend'
    delay_seconds INTEGER NOT NULL,
    recorded_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (system_id, stop_id, route_id, hour_bucket, day_type, recorded_at)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_routes_system ON gtfs_routes(system_id);
CREATE INDEX IF NOT EXISTS idx_stops_system ON gtfs_stops(system_id);
CREATE INDEX IF NOT EXISTS idx_trips_system_route ON gtfs_trips(system_id, route_id);
CREATE INDEX IF NOT EXISTS idx_delay_history_lookup
    ON delay_history(system_id, stop_id, hour_bucket, day_type);
