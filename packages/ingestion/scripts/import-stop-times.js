#!/usr/bin/env node
// packages/ingestion/scripts/import-stop-times.js
// ─────────────────────────────────────────────────────────────────────────────
// STREAMING STOP_TIMES IMPORTER
//
// Imports stop_times.txt from GTFS data using streaming CSV parsing.
// Handles 177MB+ files without loading into memory.
// After import, refreshes the route_graph materialized view.
//
// Usage:
//   node scripts/import-stop-times.js              # all systems
//   node scripts/import-stop-times.js --system mta # one system
//   node scripts/import-stop-times.js --refresh    # just refresh the graph
// ─────────────────────────────────────────────────────────────────────────────

import { createReadStream, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import pg from "pg";
import { SYSTEMS, PG_CONFIG } from "../config/systems.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOAD_DIR = join(__dirname, "..", ".data", "gtfs-static");
const BATCH_SIZE = 2000; // rows per INSERT batch

const args = process.argv.slice(2);
const systemFilter = args.includes("--system") ? args[args.indexOf("--system") + 1] : null;
const refreshOnly = args.includes("--refresh");

async function main() {
  const pool = new pg.Pool({ ...PG_CONFIG, max: 3 });

  try {
    await pool.query("SELECT 1");
    console.log(`✅ PostgreSQL connected\n`);
  } catch (err) {
    console.error(`❌ PostgreSQL connection failed: ${err.message}`);
    process.exit(1);
  }

  // Ensure stop_times table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gtfs_stop_times (
      system_id TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      stop_id TEXT NOT NULL,
      stop_sequence INTEGER NOT NULL,
      arrival_time TEXT,
      departure_time TEXT,
      PRIMARY KEY (system_id, trip_id, stop_sequence)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON gtfs_stop_times(system_id, stop_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stop_times_trip ON gtfs_stop_times(system_id, trip_id)`);

  if (!refreshOnly) {
    const systems = systemFilter
      ? { [systemFilter]: SYSTEMS[systemFilter] }
      : Object.fromEntries(Object.entries(SYSTEMS).filter(([, s]) => s.enabled));

    for (const [sysId, config] of Object.entries(systems)) {
      const filePath = findStopTimesFile(sysId);
      if (!filePath) {
        console.log(`⏭  ${config.name}: no stop_times.txt found`);
        continue;
      }

      console.log(`${"═".repeat(60)}`);
      console.log(`  Importing stop_times for ${config.name}`);
      console.log(`${"═".repeat(60)}`);

      await importStopTimes(pool, sysId, filePath);
    }
  }

  // Refresh the route graph
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Building route graph...`);
  console.log(`${"═".repeat(60)}`);
  await buildRouteGraph(pool);

  await pool.end();
  console.log("\n✅ Done.\n");
}

function findStopTimesFile(sysId) {
  const candidates = [
    join(DOWNLOAD_DIR, sysId, "stop_times.txt"),
    join(DOWNLOAD_DIR, sysId, "_primary", "stop_times.txt"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function importStopTimes(pool, sysId, filePath) {
  // Clear existing
  process.stdout.write(`  🗑  Clearing old data... `);
  await pool.query("DELETE FROM gtfs_stop_times WHERE system_id = $1", [sysId]);
  console.log("done");

  // Stream the file
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let headers = null;
  let lineNum = 0;
  let batch = [];
  let totalInserted = 0;
  const startTime = Date.now();

  for await (const line of rl) {
    lineNum++;

    if (lineNum === 1) {
      headers = line.replace(/^\uFEFF/, "").split(",").map((h) => h.trim().replace(/"/g, ""));
      continue;
    }

    const values = parseCSVLine(line);
    if (values.length !== headers.length) continue;

    const row = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = values[i];
    }

    batch.push(row);

    if (batch.length >= BATCH_SIZE) {
      await flushBatch(pool, sysId, batch);
      totalInserted += batch.length;
      batch = [];

      // Progress
      if (totalInserted % 100000 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stdout.write(`  📊 ${(totalInserted / 1000).toFixed(0)}k rows (${elapsed}s)...\r`);
      }
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    await flushBatch(pool, sysId, batch);
    totalInserted += batch.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  ✅ ${totalInserted.toLocaleString()} rows imported (${elapsed}s)`);
}

async function flushBatch(pool, sysId, batch) {
  const values = [];
  const params = [];
  let p = 1;

  for (const row of batch) {
    values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(
      sysId,
      row.trip_id || "",
      row.stop_id || "",
      parseInt(row.stop_sequence || "0"),
      row.arrival_time || null,
      row.departure_time || null
    );
  }

  await pool.query(
    `INSERT INTO gtfs_stop_times (system_id, trip_id, stop_id, stop_sequence, arrival_time, departure_time)
     VALUES ${values.join(",")}
     ON CONFLICT (system_id, trip_id, stop_sequence) DO NOTHING`,
    params
  );
}

async function buildRouteGraph(pool) {
  // Drop and rebuild the materialized views
  process.stdout.write("  📊 Building route_graph (this may take a few minutes)... ");

  await pool.query("DROP MATERIALIZED VIEW IF EXISTS stop_connections CASCADE");
  await pool.query("DROP MATERIALIZED VIEW IF EXISTS route_graph CASCADE");

  // Build route_graph: consecutive stop pairs with average travel times.
  // Uses LEAD() instead of stop_sequence+1 to correctly handle agencies that
  // increment stop_sequence by values other than 1 (e.g. MBTA uses +10).
  await pool.query(`
    CREATE MATERIALIZED VIEW route_graph AS
    WITH consecutive AS (
      SELECT
        st.system_id,
        st.trip_id,
        st.stop_id AS from_stop_id,
        st.departure_time AS dep_time,
        LEAD(st.stop_id)       OVER (PARTITION BY st.system_id, st.trip_id ORDER BY st.stop_sequence) AS to_stop_id,
        LEAD(st.arrival_time)  OVER (PARTITION BY st.system_id, st.trip_id ORDER BY st.stop_sequence) AS arr_time
      FROM gtfs_stop_times st
      WHERE st.departure_time IS NOT NULL
        AND st.departure_time ~ '^\\d+:\\d+:\\d+$'
    )
    SELECT
        c.system_id,
        c.from_stop_id,
        c.to_stop_id,
        t.route_id,
        COUNT(*) AS trip_count,
        AVG(
            (SPLIT_PART(c.arr_time, ':', 1)::int * 3600 +
             SPLIT_PART(c.arr_time, ':', 2)::int * 60 +
             SPLIT_PART(c.arr_time, ':', 3)::int)
            -
            (SPLIT_PART(c.dep_time, ':', 1)::int * 3600 +
             SPLIT_PART(c.dep_time, ':', 2)::int * 60 +
             SPLIT_PART(c.dep_time, ':', 3)::int)
        )::integer AS avg_travel_seconds
    FROM consecutive c
    JOIN gtfs_trips t ON c.system_id = t.system_id AND c.trip_id = t.trip_id
    WHERE c.to_stop_id IS NOT NULL
      AND c.arr_time IS NOT NULL
      AND c.arr_time ~ '^\\d+:\\d+:\\d+$'
    GROUP BY c.system_id, c.from_stop_id, c.to_stop_id, t.route_id
    HAVING COUNT(*) >= 2
  `);

  await pool.query(`CREATE UNIQUE INDEX idx_route_graph_pk ON route_graph(system_id, from_stop_id, to_stop_id, route_id)`);
  await pool.query(`CREATE INDEX idx_route_graph_from ON route_graph(system_id, from_stop_id)`);
  await pool.query(`CREATE INDEX idx_route_graph_to ON route_graph(system_id, to_stop_id)`);

  console.log("done");

  // Build stop_connections: simplified reachability
  process.stdout.write("  📊 Building stop_connections... ");

  await pool.query(`
    CREATE MATERIALIZED VIEW stop_connections AS
    SELECT
        system_id,
        from_stop_id,
        ARRAY_AGG(DISTINCT to_stop_id) AS reachable_stops,
        ARRAY_AGG(DISTINCT route_id) AS routes
    FROM route_graph
    GROUP BY system_id, from_stop_id
  `);

  await pool.query(`CREATE UNIQUE INDEX idx_stop_connections_pk ON stop_connections(system_id, from_stop_id)`);

  console.log("done");

  // Print stats
  const graphCount = await pool.query("SELECT COUNT(*) FROM route_graph");
  const connCount = await pool.query("SELECT COUNT(*) FROM stop_connections");

  const perSystem = await pool.query(`
    SELECT system_id, COUNT(*) as edges, COUNT(DISTINCT from_stop_id) as stops
    FROM route_graph GROUP BY system_id ORDER BY system_id
  `);

  console.log(`\n  Route graph: ${parseInt(graphCount.rows[0].count).toLocaleString()} edges`);
  console.log(`  Stop connections: ${parseInt(connCount.rows[0].count).toLocaleString()} stops with outbound routes\n`);

  for (const row of perSystem.rows) {
    console.log(`    ${row.system_id.padEnd(8)} ${parseInt(row.edges).toLocaleString().padStart(8)} edges, ${parseInt(row.stops).toLocaleString().padStart(6)} stops`);
  }
}

function parseCSVLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current.trim());
  return values;
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
