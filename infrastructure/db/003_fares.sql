-- Fare / pricing data (GTFS fare_attributes.txt + fare_rules.txt)
-- Run: psql -U connext -d connext -f 003_fares.sql

-- fare_attributes.txt — one row per fare product (price + transfer rules)
CREATE TABLE IF NOT EXISTS gtfs_fare_attributes (
    system_id         TEXT NOT NULL,
    fare_id           TEXT NOT NULL,
    price             NUMERIC(10, 2) NOT NULL,
    currency_type     TEXT NOT NULL DEFAULT 'USD',
    payment_method    INTEGER DEFAULT 0,    -- 0 = on-board, 1 = before boarding
    transfers         INTEGER,              -- NULL = unlimited, 0 = none, 1 = one, 2 = two
    transfer_duration INTEGER,              -- seconds the transfer credit is valid
    PRIMARY KEY (system_id, fare_id)
);

-- fare_rules.txt — maps fares to routes / zones
-- One row per rule; multiple rows per fare_id are OR'd together.
CREATE TABLE IF NOT EXISTS gtfs_fare_rules (
    system_id       TEXT NOT NULL,
    fare_id         TEXT NOT NULL,
    route_id        TEXT,       -- NULL = applies to all routes (flat fare)
    origin_id       TEXT,       -- stop zone for zone-based fares
    destination_id  TEXT,
    contains_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_fare_rules_system_route
    ON gtfs_fare_rules (system_id, route_id);

CREATE INDEX IF NOT EXISTS idx_fare_rules_system_fare
    ON gtfs_fare_rules (system_id, fare_id);

CREATE INDEX IF NOT EXISTS idx_fare_attrs_system
    ON gtfs_fare_attributes (system_id);
