-- GTFS Fares v2 tables (MBTA and other modern agencies)
-- Complements 003_fares.sql which handles the legacy v1 format.

-- fare_products.txt — purchasable fare items (price + payment media)
CREATE TABLE IF NOT EXISTS gtfs_fare_products (
    system_id          TEXT NOT NULL,
    fare_product_id    TEXT NOT NULL,
    fare_product_name  TEXT,
    fare_media_id      TEXT,
    amount             NUMERIC(10, 2) NOT NULL,
    currency           TEXT NOT NULL DEFAULT 'USD',
    UNIQUE (system_id, fare_product_id, fare_media_id)
);

-- fare_media.txt — payment methods (cash, card, app, etc.)
CREATE TABLE IF NOT EXISTS gtfs_fare_media (
    system_id       TEXT NOT NULL,
    fare_media_id   TEXT NOT NULL,
    fare_media_name TEXT,
    fare_media_type INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (system_id, fare_media_id)
);

-- fare_leg_rules.txt — maps a journey leg (by network/area) to a fare product
CREATE TABLE IF NOT EXISTS gtfs_fare_leg_rules (
    system_id               TEXT NOT NULL,
    leg_group_id            TEXT,
    network_id              TEXT,
    from_area_id            TEXT,
    to_area_id              TEXT,
    fare_product_id         TEXT NOT NULL,
    from_timeframe_group_id TEXT,
    to_timeframe_group_id   TEXT,
    transfer_only           INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_fare_leg_rules_network
    ON gtfs_fare_leg_rules (system_id, network_id);

CREATE INDEX IF NOT EXISTS idx_fare_leg_rules_product
    ON gtfs_fare_leg_rules (system_id, fare_product_id);

-- fare_transfer_rules.txt — free/discounted transfers between leg groups
CREATE TABLE IF NOT EXISTS gtfs_fare_transfer_rules (
    system_id            TEXT NOT NULL,
    from_leg_group_id    TEXT,
    to_leg_group_id      TEXT,
    transfer_count       INTEGER,   -- -1 = unlimited, NULL = unlimited
    duration_limit       INTEGER,   -- seconds
    duration_limit_type  INTEGER,
    fare_transfer_type   INTEGER NOT NULL DEFAULT 0,
    fare_product_id      TEXT,
    filter_fare_product_id TEXT
);

-- stop_areas.txt — maps stops to fare zones (for area-based fares)
CREATE TABLE IF NOT EXISTS gtfs_stop_areas (
    system_id TEXT NOT NULL,
    stop_id   TEXT NOT NULL,
    area_id   TEXT NOT NULL,
    PRIMARY KEY (system_id, stop_id, area_id)
);

CREATE INDEX IF NOT EXISTS idx_stop_areas_system_stop
    ON gtfs_stop_areas (system_id, stop_id);

-- areas.txt — human-readable area names
CREATE TABLE IF NOT EXISTS gtfs_areas (
    system_id TEXT NOT NULL,
    area_id   TEXT NOT NULL,
    area_name TEXT,
    PRIMARY KEY (system_id, area_id)
);

-- networks.txt — network groupings (some agencies supply this explicitly)
-- For MBTA the network_ids come from routes.txt network_id field instead
CREATE TABLE IF NOT EXISTS gtfs_networks (
    system_id   TEXT NOT NULL,
    network_id  TEXT NOT NULL,
    network_name TEXT,
    PRIMARY KEY (system_id, network_id)
);
