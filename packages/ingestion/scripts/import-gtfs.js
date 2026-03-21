#!/usr/bin/env node
// packages/ingestion/scripts/import-gtfs.js
// ─────────────────────────────────────────────────────────────────────────────
// GTFS STATIC DATA IMPORTER
//
// Downloads static GTFS zip files from each transit agency, extracts the
// relevant .txt files (routes, stops, trips, transfers), and loads them
// into PostgreSQL.
//
// Usage:
//   node scripts/import-gtfs.js              # import all enabled systems
//   node scripts/import-gtfs.js --system mta # import just one system
//   node scripts/import-gtfs.js --list       # show available systems
// ─────────────────────────────────────────────────────────────────────────────

import { createWriteStream, createReadStream, existsSync, mkdirSync, rmSync, readdirSync, appendFileSync } from "fs";
import { readFile } from "fs/promises";
import { pipeline } from "stream/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { request } from "undici";
import { createInterface } from "readline";
import pg from "pg";
import { SYSTEMS, PG_CONFIG } from "../config/systems.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOAD_DIR = join(__dirname, "..", ".data", "gtfs-static");

// ─── CLI Parsing ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const systemFilter = args.includes("--system") ? args[args.indexOf("--system") + 1] : null;
const listOnly = args.includes("--list");

if (listOnly) {
  console.log("\nAvailable systems:\n");
  for (const [id, sys] of Object.entries(SYSTEMS)) {
    console.log(`  ${id.padEnd(8)} ${sys.name.padEnd(8)} ${sys.city.padEnd(20)} ${sys.staticGtfs?.url ? "✅ Has GTFS URL" : "❌ No URL"}`);
  }
  console.log(`\nUsage: node scripts/import-gtfs.js --system ${Object.keys(SYSTEMS)[0]}\n`);
  process.exit(0);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const pool = new pg.Pool(PG_CONFIG);

  try {
    await pool.query("SELECT 1");
    console.log(`✅ PostgreSQL connected: ${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database}\n`);
  } catch (err) {
    console.error(`❌ PostgreSQL connection failed: ${err.message}`);
    console.error("   Make sure Docker is running: docker compose up -d");
    process.exit(1);
  }

  mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const systemsToImport = systemFilter
    ? { [systemFilter]: SYSTEMS[systemFilter] }
    : Object.fromEntries(Object.entries(SYSTEMS).filter(([, s]) => s.enabled && s.staticGtfs?.url));

  if (systemFilter && !SYSTEMS[systemFilter]) {
    console.error(`❌ System "${systemFilter}" not found. Run with --list to see available systems.`);
    process.exit(1);
  }

  for (const [sysId, config] of Object.entries(systemsToImport)) {
    if (!config.staticGtfs?.url) {
      console.log(`⏭  ${config.name}: no static GTFS URL configured, skipping`);
      continue;
    }

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  Importing ${config.name} (${config.city})`);
    console.log(`${"═".repeat(60)}`);

    try {
      const zipPath = join(DOWNLOAD_DIR, `${sysId}.zip`);
      await downloadFile(config.staticGtfs.url, zipPath);

      const extractDir = join(DOWNLOAD_DIR, sysId);
      await extractGtfs(zipPath, extractDir);

      await importRoutes(pool, sysId, extractDir);
      await importStops(pool, sysId, extractDir);
      await importTrips(pool, sysId, extractDir);
      await importTransfers(pool, sysId, extractDir);

      const counts = await getCounts(pool, sysId);
      console.log(`\n  ✅ ${config.name} import complete:`);
      console.log(`     Routes:    ${counts.routes}`);
      console.log(`     Stops:     ${counts.stops}`);
      console.log(`     Trips:     ${counts.trips}`);
      console.log(`     Transfers: ${counts.transfers}`);

    } catch (err) {
      console.error(`\n  ❌ ${config.name} import failed: ${err.message}`);
    }
  }

  await pool.end();
  console.log("\n✅ All imports complete.\n");
}

// ─── Download ────────────────────────────────────────────────────────────────
async function downloadFile(url, destPath) {
  process.stdout.write(`  📥 Downloading ${url.slice(0, 70)}... `);

  const { statusCode, body } = await request(url, {
    maxRedirections: 5,
    headers: { "User-Agent": "Connext-GTFS-Import/1.0" },
  });

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`HTTP ${statusCode} downloading ${url}`);
  }

  const fileStream = createWriteStream(destPath);
  await pipeline(body, fileStream);

  const stat = await readFile(destPath);
  console.log(`${(stat.length / 1024 / 1024).toFixed(1)} MB`);
}

// ─── Extract GTFS ZIP ────────────────────────────────────────────────────────
async function extractGtfs(zipPath, destDir) {
  process.stdout.write(`  📦 Extracting... `);

  if (existsSync(destDir)) rmSync(destDir, { recursive: true });
  mkdirSync(destDir, { recursive: true });

  // First extraction
  try {
    execSync(`unzip -o -q "${zipPath}" -d "${destDir}"`, { stdio: "pipe" });
  } catch {
    execSync(`unzip -o -q -j "${zipPath}" -d "${destDir}"`, { stdio: "pipe" });
  }

  // Check what we got
  let files = readdirSync(destDir);
  let txtFiles = files.filter((f) => f.endsWith(".txt"));
  const nestedZips = files.filter((f) => f.endsWith(".zip"));

  // ─── Case 1: Nested zips (SEPTA style) ──────────────────────────────
  if (txtFiles.length === 0 && nestedZips.length > 0) {
    console.log(`nested archive (${nestedZips.join(", ")})`);

    // Prefer rail zip first (has subway/trolley/regional rail)
    const railZip = nestedZips.find((f) => f.includes("rail"));
    const busZip = nestedZips.find((f) => f.includes("bus"));
    const primaryZip = railZip || nestedZips[0];

    // Extract primary zip
    const primaryDir = join(destDir, "_primary");
    mkdirSync(primaryDir, { recursive: true });
    execSync(`unzip -o -q -j "${join(destDir, primaryZip)}" -d "${primaryDir}"`, { stdio: "pipe" });

    // Copy to main dir
    for (const f of readdirSync(primaryDir)) {
      execSync(`cp "${join(primaryDir, f)}" "${join(destDir, f)}"`, { stdio: "pipe" });
    }

    // Merge secondary zip if it exists (append rows, skip headers)
    const secondaryZip = primaryZip === railZip ? busZip : null;
    if (secondaryZip) {
      const secDir = join(destDir, "_secondary");
      mkdirSync(secDir, { recursive: true });
      execSync(`unzip -o -q -j "${join(destDir, secondaryZip)}" -d "${secDir}"`, { stdio: "pipe" });

      for (const fileName of ["routes.txt", "stops.txt", "trips.txt", "transfers.txt"]) {
        const secFile = join(secDir, fileName);
        const mainFile = join(destDir, fileName);
        if (existsSync(secFile)) {
          const content = await readFile(secFile, "utf-8");
          const lines = content.split("\n").slice(1).filter((l) => l.trim());
          if (lines.length > 0) {
            if (existsSync(mainFile)) {
              appendFileSync(mainFile, "\n" + lines.join("\n"));
            } else {
              execSync(`cp "${secFile}" "${mainFile}"`, { stdio: "pipe" });
            }
          }
        }
      }
      process.stdout.write(`  📦 Merged ${primaryZip} + ${secondaryZip}... `);
    }

  // ─── Case 2: Files in a subdirectory ─────────────────────────────────
  } else if (txtFiles.length === 0) {
    const subdirs = files.filter((f) => {
      try { return readdirSync(join(destDir, f)).some((sf) => sf.endsWith(".txt")); }
      catch { return false; }
    });

    if (subdirs.length > 0) {
      for (const f of readdirSync(join(destDir, subdirs[0]))) {
        execSync(`cp "${join(destDir, subdirs[0], f)}" "${join(destDir, f)}"`, { stdio: "pipe" });
      }
    }
  }

  // Final count
  const finalFiles = readdirSync(destDir).filter((f) => f.endsWith(".txt"));
  console.log(`${finalFiles.length} txt files`);
}

// ─── CSV Parser ──────────────────────────────────────────────────────────────
async function parseCSV(filePath) {
  if (!existsSync(filePath)) return [];

  const rows = [];
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let headers = null;
  let lineNum = 0;

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
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
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

// ─── Import Routes ───────────────────────────────────────────────────────────
async function importRoutes(pool, sysId, dir) {
  const filePath = join(dir, "routes.txt");
  const rows = await parseCSV(filePath);
  if (rows.length === 0) { console.log("  ⚠  routes.txt not found or empty"); return; }

  // Deduplicate
  const seen = new Set();
  const unique = rows.filter((r) => { const k = r.route_id; if (seen.has(k)) return false; seen.add(k); return true; });
  const dupes = rows.length - unique.length;

  process.stdout.write(`  📊 Routes: ${rows.length}${dupes ? ` (${dupes} dupes)` : ""}... `);
  await pool.query("DELETE FROM gtfs_routes WHERE system_id = $1", [sysId]);

  let inserted = 0;
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const values = []; const params = []; let p = 1;
    for (const row of batch) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(sysId, row.route_id||"", row.route_short_name||"", row.route_long_name||"", (row.route_color||"").replace("#",""), parseInt(row.route_type||"0"));
    }
    await pool.query(`INSERT INTO gtfs_routes (system_id,route_id,route_short_name,route_long_name,route_color,route_type) VALUES ${values.join(",")} ON CONFLICT (system_id,route_id) DO UPDATE SET route_short_name=EXCLUDED.route_short_name,route_long_name=EXCLUDED.route_long_name,route_color=EXCLUDED.route_color,route_type=EXCLUDED.route_type`, params);
    inserted += batch.length;
  }
  console.log(`${inserted} imported`);
}

// ─── Import Stops ────────────────────────────────────────────────────────────
async function importStops(pool, sysId, dir) {
  const filePath = join(dir, "stops.txt");
  const rows = await parseCSV(filePath);
  if (rows.length === 0) { console.log("  ⚠  stops.txt not found or empty"); return; }

  const seen = new Set();
  const unique = rows.filter((r) => { const k = r.stop_id; if (seen.has(k)) return false; seen.add(k); return true; });
  const dupes = rows.length - unique.length;

  process.stdout.write(`  📊 Stops: ${rows.length}${dupes ? ` (${dupes} dupes)` : ""}... `);
  await pool.query("DELETE FROM gtfs_stops WHERE system_id = $1", [sysId]);

  let inserted = 0;
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const values = []; const params = []; let p = 1;
    for (const row of batch) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(sysId, row.stop_id||"", row.stop_name||"", parseFloat(row.stop_lat||"0"), parseFloat(row.stop_lon||"0"), row.parent_station||"");
    }
    await pool.query(`INSERT INTO gtfs_stops (system_id,stop_id,stop_name,stop_lat,stop_lon,parent_station) VALUES ${values.join(",")} ON CONFLICT (system_id,stop_id) DO UPDATE SET stop_name=EXCLUDED.stop_name,stop_lat=EXCLUDED.stop_lat,stop_lon=EXCLUDED.stop_lon,parent_station=EXCLUDED.parent_station`, params);
    inserted += batch.length;
  }
  console.log(`${inserted} imported`);
}

// ─── Import Trips ────────────────────────────────────────────────────────────
async function importTrips(pool, sysId, dir) {
  const filePath = join(dir, "trips.txt");
  const rows = await parseCSV(filePath);
  if (rows.length === 0) { console.log("  ⚠  trips.txt not found or empty"); return; }

  const seen = new Set();
  const unique = rows.filter((r) => { const k = r.trip_id; if (seen.has(k)) return false; seen.add(k); return true; });
  const dupes = rows.length - unique.length;

  process.stdout.write(`  📊 Trips: ${rows.length}${dupes ? ` (${dupes} dupes)` : ""}... `);
  await pool.query("DELETE FROM gtfs_trips WHERE system_id = $1", [sysId]);

  let inserted = 0;
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const values = []; const params = []; let p = 1;
    for (const row of batch) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(sysId, row.trip_id||"", row.route_id||"", parseInt(row.direction_id||"0"), row.trip_headsign||"", row.service_id||"");
    }
    await pool.query(`INSERT INTO gtfs_trips (system_id,trip_id,route_id,direction_id,trip_headsign,service_id) VALUES ${values.join(",")} ON CONFLICT (system_id,trip_id) DO UPDATE SET route_id=EXCLUDED.route_id,direction_id=EXCLUDED.direction_id,trip_headsign=EXCLUDED.trip_headsign,service_id=EXCLUDED.service_id`, params);
    inserted += batch.length;
  }
  console.log(`${inserted} imported`);
}

// ─── Import Transfers ────────────────────────────────────────────────────────
async function importTransfers(pool, sysId, dir) {
  const filePath = join(dir, "transfers.txt");
  const rows = await parseCSV(filePath);
  if (rows.length === 0) { console.log("  ℹ  transfers.txt not found (manual overrides will be used)"); return; }

  const seen = new Set();
  const unique = rows.filter((r) => {
    const k = `${r.from_stop_id}:${r.to_stop_id}:${r.from_route_id||""}:${r.to_route_id||""}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  const dupes = rows.length - unique.length;

  process.stdout.write(`  📊 Transfers: ${rows.length}${dupes ? ` (${dupes} dupes)` : ""}... `);
  await pool.query("DELETE FROM gtfs_transfers WHERE system_id = $1", [sysId]);

  let inserted = 0;
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const values = []; const params = []; let p = 1;
    for (const row of batch) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(sysId, row.from_stop_id||"", row.to_stop_id||"", parseInt(row.transfer_type||"0"), row.min_transfer_time ? parseInt(row.min_transfer_time) : null, row.from_route_id||"", row.to_route_id||"");
    }
    await pool.query(`INSERT INTO gtfs_transfers (system_id,from_stop_id,to_stop_id,transfer_type,min_transfer_time,from_route_id,to_route_id) VALUES ${values.join(",")} ON CONFLICT (system_id,from_stop_id,to_stop_id,from_route_id,to_route_id) DO UPDATE SET transfer_type=EXCLUDED.transfer_type,min_transfer_time=EXCLUDED.min_transfer_time`, params);
    inserted += batch.length;
  }
  console.log(`${inserted} imported`);
}

// ─── Counts ──────────────────────────────────────────────────────────────────
async function getCounts(pool, sysId) {
  const [routes, stops, trips, transfers] = await Promise.all([
    pool.query("SELECT COUNT(*) FROM gtfs_routes WHERE system_id = $1", [sysId]),
    pool.query("SELECT COUNT(*) FROM gtfs_stops WHERE system_id = $1", [sysId]),
    pool.query("SELECT COUNT(*) FROM gtfs_trips WHERE system_id = $1", [sysId]),
    pool.query("SELECT COUNT(*) FROM gtfs_transfers WHERE system_id = $1", [sysId]),
  ]);
  return {
    routes: parseInt(routes.rows[0].count), stops: parseInt(stops.rows[0].count),
    trips: parseInt(trips.rows[0].count), transfers: parseInt(transfers.rows[0].count),
  };
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
