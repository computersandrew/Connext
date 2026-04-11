// packages/api/src/routes/planner.js
import { SYSTEMS } from "../config.js";

const engines = new Map();

async function initEngines(pg, logger) {
  try {
    const { TransferEngine } = await import("../../src-shared/TransferEngine.js");
    const { TRANSFER_OVERRIDES } = await import("../../src-shared/transfer-overrides.js");
    for (const sysId of Object.keys(SYSTEMS)) {
      const engine = new TransferEngine(logger);
      if (pg) await engine.loadFromGtfs(pg, sysId);
      if (TRANSFER_OVERRIDES[sysId]) engine.loadManualOverrides(TRANSFER_OVERRIDES[sysId]);
      engines.set(sysId, engine);
    }
  } catch (err) {
    logger.warn({ err: err.message }, "Could not load transfer engines");
  }
}

export default async function plannerRoutes(fastify, { pg }) {
  await initEngines(pg, fastify.log);

  fastify.get("/api/v1/plan/:system", async (req, reply) => {
    const { system } = req.params;
    const { from, to, depart, pace } = req.query;

    if (!SYSTEMS[system]) return reply.code(404).send({ error: "SYSTEM_NOT_FOUND" });
    if (!from || !to) return reply.code(400).send({ error: "MISSING_PARAMS", message: "Both 'from' and 'to' required" });
    if (!pg) return reply.code(503).send({ error: "DB_UNAVAILABLE" });

    const engine = engines.get(system);
    const now = Math.floor(Date.now() / 1000);
    const walkingPace = pace || "average";
    const hour = new Date().getHours();
    const rushHour = (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19);

    const fromStops = await resolveStopIds(pg, system, from);
    const toStops = await resolveStopIds(pg, system, to);

    const routes = [];

    // ─── 1. Direct routes: same route serves both origin and destination ───
    try {
      const directResult = await pg.query(`
        WITH from_routes AS (
          SELECT DISTINCT route_id
          FROM route_graph
          WHERE system_id = $1 AND (from_stop_id = ANY($2) OR to_stop_id = ANY($2))
        ),
        to_routes AS (
          SELECT DISTINCT route_id
          FROM route_graph
          WHERE system_id = $1 AND (from_stop_id = ANY($3) OR to_stop_id = ANY($3))
        )
        SELECT fr.route_id
        FROM from_routes fr
        JOIN to_routes tr ON fr.route_id = tr.route_id
        LIMIT 5
      `, [system, fromStops, toStops]);

      for (const row of directResult.rows) {
        const rideSec = await estimateRideTime(pg, system, row.route_id, fromStops, toStops);
        const routeInfo = await getRouteInfo(pg, system, row.route_id);
        const walkSec = walkTimeSec(walkingPace);

        routes.push({
          id: `direct-${row.route_id}`,
          type: "direct",
          totalTimeSec: walkSec + rideSec,
          totalTimeMin: Math.round((walkSec + rideSec) / 60),
          transfers: 0,
          overallProbability: null,
          leaveBy: new Date((now - walkSec) * 1000).toISOString(),
          legs: [
            { type: "walk", durationSec: walkSec, durationMin: Math.round(walkSec / 60), description: "Walk to stop" },
            {
              type: "ride", routeId: row.route_id,
              routeName: routeInfo.name, routeColor: routeInfo.color,
              from, to, durationSec: rideSec, durationMin: Math.round(rideSec / 60),
              direction: "", isRealtime: false,
            },
          ],
        });
      }
    } catch (err) {
      fastify.log.debug({ err: err.message }, "Direct route query failed");
    }

    // ─── 2. One-transfer routes ───────────────────────────────────────────
    // Groups stops by (route, physical station) so that agencies with separate
    // inbound/outbound stop IDs (e.g. MBTA) use ALL stop IDs for each route at
    // the transfer station. Without this, estimateRideTime would start from the
    // wrong directional stop (e.g. Copley inbound → goes toward downtown, not BC).
    try {
      const transferResult = await pg.query(`
        WITH from_routes AS (
          SELECT DISTINCT route_id
          FROM route_graph
          WHERE system_id = $1 AND (from_stop_id = ANY($2) OR to_stop_id = ANY($2))
        ),
        to_routes AS (
          SELECT DISTINCT route_id
          FROM route_graph
          WHERE system_id = $1 AND (from_stop_id = ANY($3) OR to_stop_id = ANY($3))
        ),
        -- Collect ALL stop IDs per (route, physical station).
        -- COALESCE uses parent_station when set (MBTA, SEPTA) or falls back to
        -- stop_id so that routes sharing a stop ID (MTA) still match correctly.
        route_station_stops AS (
          SELECT
            COALESCE(NULLIF(s.parent_station, ''), s.stop_id) AS station_id,
            rg.route_id,
            ARRAY_AGG(DISTINCT rg.from_stop_id) AS stop_ids,
            MIN(rg.from_stop_id) AS rep_stop_id
          FROM route_graph rg
          JOIN gtfs_stops s ON s.system_id = $1 AND s.stop_id = rg.from_stop_id
          WHERE rg.system_id = $1
          GROUP BY COALESCE(NULLIF(s.parent_station, ''), s.stop_id), rg.route_id
        ),
        -- Any two routes that share a physical station form a transfer candidate.
        -- Returns stop-ID arrays for BOTH routes so each ride leg uses the correct stops.
        transfer_candidates AS (
          SELECT DISTINCT
            fr.route_id  AS route1,
            rss1.stop_ids AS stops_r1,   -- route1 stops at the transfer station
            tr.route_id  AS route2,
            rss2.stop_ids AS stops_r2,   -- route2 stops at the transfer station
            rss1.rep_stop_id AS transfer_rep
          FROM from_routes fr
          JOIN route_station_stops rss1 ON rss1.route_id = fr.route_id
          JOIN route_station_stops rss2
            ON rss2.station_id = rss1.station_id AND rss2.route_id != fr.route_id
          JOIN to_routes tr ON rss2.route_id = tr.route_id
          WHERE fr.route_id != tr.route_id
        )
        SELECT DISTINCT ON (route1, route2)
          route1, route2, stops_r1, stops_r2, transfer_rep
        FROM transfer_candidates
        LIMIT 10
      `, [system, fromStops, toStops]);

      for (const row of transferResult.rows) {
        const route1Info = await getRouteInfo(pg, system, row.route1);
        const route2Info = await getRouteInfo(pg, system, row.route2);
        const transferStopName = await getStopName(pg, system, row.transfer_rep);
        const walkSec = walkTimeSec(walkingPace);

        // Each leg uses the correct stop-ID array for its route at the transfer station:
        //   Leg 1: origin → route1's stops at the transfer station
        //   Leg 2: route2's stops at the transfer station → destination
        const ride1Sec = await estimateRideTime(pg, system, row.route1, fromStops, row.stops_r1);
        const ride2Sec = await estimateRideTime(pg, system, row.route2, row.stops_r2, toStops);

        let transferInfo = { probability: 0.75, transferTime: 120, type: "unknown", notes: null, accessibility: null };
        if (engine) {
          transferInfo = engine.calculateConnectionProbability(
            row.transfer_rep, row.transfer_rep, 180,
            { fromRouteId: row.route1, toRouteId: row.route2, rushHour, walkingPace }
          );
        }

        const totalSec = walkSec + ride1Sec + transferInfo.transferTime + ride2Sec;

        routes.push({
          id: `transfer-${row.route1}-${row.route2}-${row.transfer_rep}`,
          type: "one_transfer",
          totalTimeSec: totalSec,
          totalTimeMin: Math.round(totalSec / 60),
          transfers: 1,
          overallProbability: transferInfo.probability,
          leaveBy: new Date((now - walkSec) * 1000).toISOString(),
          legs: [
            { type: "walk", durationSec: walkSec, durationMin: Math.round(walkSec / 60), description: "Walk to stop" },
            {
              type: "ride", routeId: row.route1,
              routeName: route1Info.name, routeColor: route1Info.color,
              from, to: row.transfer_rep,
              durationSec: ride1Sec, durationMin: Math.round(ride1Sec / 60),
              direction: "", isRealtime: false,
            },
            {
              type: "transfer", station: transferStopName, stationId: row.transfer_rep,
              transferType: transferInfo.type,
              transferTimeSec: transferInfo.transferTime,
              transferTimeMin: Math.round(transferInfo.transferTime / 60 * 10) / 10,
              bufferSec: 180, bufferMin: 3,
              probability: transferInfo.probability,
              probabilityPct: Math.round(transferInfo.probability * 100),
              accessibility: transferInfo.accessibility || null,
              notes: transferInfo.notes || null,
              platformChange: transferInfo.type !== "same_platform",
            },
            {
              type: "ride", routeId: row.route2,
              routeName: route2Info.name, routeColor: route2Info.color,
              from: row.transfer_rep, to,
              durationSec: ride2Sec, durationMin: Math.round(ride2Sec / 60),
              direction: "", isRealtime: false,
            },
          ],
        });
      }
    } catch (err) {
      fastify.log.debug({ err: err.message }, "Transfer route query failed");
    }

    // ─── 3. Two-transfer routes ───────────────────────────────────────────
    // Finds route1 → transfer_station_1 → route2 → transfer_station_2 → route3
    // Only considers rail/rapid-transit routes to avoid bus combinatorial explosion.
    // Uses parent_station grouping to handle agencies with split stop IDs per line
    // (e.g. MBTA uses separate inbound/outbound stop IDs at each station).
    // The SQL returns stop-ID arrays for EACH route at EACH transfer station so
    // estimateRideTime always uses the correct stop IDs for the route being timed.
    try {
      const twoXferResult = await pg.query(`
        WITH
        rail_routes AS (
          SELECT route_id FROM gtfs_routes
          WHERE system_id = $1 AND route_type IN (0, 1, 2)
        ),
        from_routes AS (
          SELECT DISTINCT rg.route_id
          FROM route_graph rg JOIN rail_routes rr ON rg.route_id = rr.route_id
          WHERE rg.system_id = $1 AND (rg.from_stop_id = ANY($2) OR rg.to_stop_id = ANY($2))
        ),
        to_routes AS (
          SELECT DISTINCT rg.route_id
          FROM route_graph rg JOIN rail_routes rr ON rg.route_id = rr.route_id
          WHERE rg.system_id = $1 AND (rg.from_stop_id = ANY($3) OR rg.to_stop_id = ANY($3))
        ),
        -- All rail stops in the route_graph, grouped by (physical_station, route)
        -- so we get an array of ALL stop IDs for a given route at a given station.
        -- This correctly handles agencies (MBTA) that have separate inbound/outbound
        -- stop IDs at the same physical station.
        route_station_stops AS (
          SELECT
            COALESCE(NULLIF(s.parent_station, ''), s.stop_id) AS station_id,
            rg.route_id,
            ARRAY_AGG(DISTINCT rg.from_stop_id) AS stop_ids,
            MIN(rg.from_stop_id) AS rep_stop_id   -- representative ID for display
          FROM route_graph rg
          JOIN rail_routes rr ON rg.route_id = rr.route_id
          JOIN gtfs_stops s ON s.system_id = $1 AND s.stop_id = rg.from_stop_id
          WHERE rg.system_id = $1
          GROUP BY COALESCE(NULLIF(s.parent_station, ''), s.stop_id), rg.route_id
        ),
        -- All pairs of routes sharing a physical station, with their respective stop-ID arrays.
        -- station_id is propagated so the two_xfer CTE can enforce truly distinct stations.
        route_xfers AS (
          SELECT DISTINCT
            rss1.station_id  AS station_id,  -- physical station (parent_station or stop_id)
            rss1.route_id    AS route_a,
            rss1.stop_ids    AS stops_a,     -- all stop IDs for route_a at this station
            rss1.rep_stop_id AS rep_a,
            rss2.route_id    AS route_b,
            rss2.stop_ids    AS stops_b,     -- all stop IDs for route_b at this station
            rss2.rep_stop_id AS rep_b
          FROM route_station_stops rss1
          JOIN route_station_stops rss2
            ON rss1.station_id = rss2.station_id AND rss1.route_id != rss2.route_id
        ),
        -- Two-transfer paths: route1 → station1 → route2 → station2 → route3
        -- Returns stop arrays for BOTH routes at EACH transfer station so ride-
        -- time estimation uses the correct stop IDs for each leg.
        two_xfer AS (
          SELECT DISTINCT
            rx1.route_a    AS route1,
            rx1.stops_a    AS t1_stops_r1,   -- route1 stops at station1
            rx1.rep_a      AS t1_rep,         -- representative stop (for display)
            rx1.route_b    AS route2,
            rx1.stops_b    AS t1_stops_r2,   -- route2 stops at station1
            rx2.stops_a    AS t2_stops_r2,   -- route2 stops at station2
            rx2.rep_a      AS t2_rep,         -- representative stop (for display)
            rx2.route_b    AS route3,
            rx2.stops_b    AS t2_stops_r3    -- route3 stops at station2
          FROM from_routes fr
          JOIN route_xfers rx1 ON rx1.route_a = fr.route_id
          JOIN route_xfers rx2 ON rx2.route_a = rx1.route_b
          JOIN to_routes tr ON rx2.route_b = tr.route_id
          WHERE rx1.route_b != rx2.route_b        -- middle route ≠ final route
            AND rx1.route_a != rx2.route_b        -- no loop back to starting route
            AND rx1.station_id != rx2.station_id  -- two DISTINCT physical stations
        )
        SELECT DISTINCT ON (route1, route2, route3)
          route1, t1_stops_r1, t1_stops_r2, t1_rep,
          route2, t2_stops_r2, t2_stops_r3, t2_rep,
          route3
        FROM two_xfer
        LIMIT 5
      `, [system, fromStops, toStops]);

      for (const row of twoXferResult.rows) {
        const [r1Info, r2Info, r3Info, t1Name, t2Name] = await Promise.all([
          getRouteInfo(pg, system, row.route1),
          getRouteInfo(pg, system, row.route2),
          getRouteInfo(pg, system, row.route3),
          getStopName(pg, system, row.t1_rep),
          getStopName(pg, system, row.t2_rep),
        ]);
        const walkSec = walkTimeSec(walkingPace);

        // Each leg uses the stop-ID array for the CORRECT route at each station:
        //   Leg 1: from origin → route1's stops at station1
        //   Leg 2: from route2's stops at station1 → route2's stops at station2
        //   Leg 3: from route3's stops at station2 → destination
        const [ride1Sec, ride2Sec, ride3Sec] = await Promise.all([
          estimateRideTime(pg, system, row.route1, fromStops, row.t1_stops_r1),
          estimateRideTime(pg, system, row.route2, row.t1_stops_r2, row.t2_stops_r2),
          estimateRideTime(pg, system, row.route3, row.t2_stops_r3, toStops),
        ]);

        let xfer1Info = { probability: 0.75, transferTime: 120, type: "unknown", notes: null, accessibility: null };
        let xfer2Info = { probability: 0.75, transferTime: 120, type: "unknown", notes: null, accessibility: null };
        if (engine) {
          xfer1Info = engine.calculateConnectionProbability(row.t1_rep, row.t1_rep, 180, { fromRouteId: row.route1, toRouteId: row.route2, rushHour, walkingPace });
          xfer2Info = engine.calculateConnectionProbability(row.t2_rep, row.t2_rep, 180, { fromRouteId: row.route2, toRouteId: row.route3, rushHour, walkingPace });
        }

        const totalSec = walkSec + ride1Sec + xfer1Info.transferTime + ride2Sec + xfer2Info.transferTime + ride3Sec;
        const overallProb = xfer1Info.probability * xfer2Info.probability;

        routes.push({
          id: `transfer2-${row.route1}-${row.route2}-${row.route3}-${row.t1_rep}-${row.t2_rep}`,
          type: "two_transfers",
          totalTimeSec: totalSec,
          totalTimeMin: Math.round(totalSec / 60),
          transfers: 2,
          overallProbability: overallProb,
          leaveBy: new Date((now - walkSec) * 1000).toISOString(),
          legs: [
            { type: "walk", durationSec: walkSec, durationMin: Math.round(walkSec / 60), description: "Walk to stop" },
            {
              type: "ride", routeId: row.route1,
              routeName: r1Info.name, routeColor: r1Info.color,
              from, to: row.t1_rep,
              durationSec: ride1Sec, durationMin: Math.round(ride1Sec / 60),
              direction: "", isRealtime: false,
            },
            {
              type: "transfer", station: t1Name, stationId: row.t1_rep,
              transferType: xfer1Info.type, transferTimeSec: xfer1Info.transferTime,
              transferTimeMin: Math.round(xfer1Info.transferTime / 60 * 10) / 10,
              bufferSec: 180, bufferMin: 3,
              probability: xfer1Info.probability,
              probabilityPct: Math.round(xfer1Info.probability * 100),
              accessibility: xfer1Info.accessibility || null,
              notes: xfer1Info.notes || null,
              platformChange: xfer1Info.type !== "same_platform",
            },
            {
              type: "ride", routeId: row.route2,
              routeName: r2Info.name, routeColor: r2Info.color,
              from: row.t1_rep, to: row.t2_rep,
              durationSec: ride2Sec, durationMin: Math.round(ride2Sec / 60),
              direction: "", isRealtime: false,
            },
            {
              type: "transfer", station: t2Name, stationId: row.t2_rep,
              transferType: xfer2Info.type, transferTimeSec: xfer2Info.transferTime,
              transferTimeMin: Math.round(xfer2Info.transferTime / 60 * 10) / 10,
              bufferSec: 180, bufferMin: 3,
              probability: xfer2Info.probability,
              probabilityPct: Math.round(xfer2Info.probability * 100),
              accessibility: xfer2Info.accessibility || null,
              notes: xfer2Info.notes || null,
              platformChange: xfer2Info.type !== "same_platform",
            },
            {
              type: "ride", routeId: row.route3,
              routeName: r3Info.name, routeColor: r3Info.color,
              from: row.t2_rep, to,
              durationSec: ride3Sec, durationMin: Math.round(ride3Sec / 60),
              direction: "", isRealtime: false,
            },
          ],
        });
      }
    } catch (err) {
      fastify.log.debug({ err: err.message }, "Two-transfer route query failed");
    }

    // Sort and deduplicate
    routes.sort((a, b) => a.totalTimeSec - b.totalTimeSec);
    const seen = new Set();
    const unique = routes.filter((r) => {
      const key = r.legs.filter((l) => l.routeId).map((l) => l.routeId).join("-");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      system: SYSTEMS[system], from, to,
      departAt: new Date(now * 1000).toISOString(),
      rushHour, walkingPace,
      routes: unique.slice(0, 5),
      count: Math.min(unique.length, 5),
      timestamp: new Date().toISOString(),
    };
  });

  // ─── Transfer info ───────────────────────────────────────────────────
  fastify.get("/api/v1/transfer/:system/:fromStop/:toStop", async (req, reply) => {
    const { system, fromStop, toStop } = req.params;
    const { fromRoute, toRoute } = req.query;
    if (!SYSTEMS[system]) return reply.code(404).send({ error: "SYSTEM_NOT_FOUND" });
    const engine = engines.get(system);
    if (!engine) return reply.code(500).send({ error: "ENGINE_NOT_LOADED" });

    const transfer = engine.getTransfer(fromStop, toStop, fromRoute || null, toRoute || null);
    if (!transfer) return { system: SYSTEMS[system], from: fromStop, to: toStop, transfer: null };

    const probabilities = [60, 120, 180, 240, 300, 420, 600].map((buffer) => ({
      bufferSeconds: buffer, bufferMinutes: buffer / 60,
      probability: engine.calculateConnectionProbability(fromStop, toStop, buffer, { fromRouteId: fromRoute, toRouteId: toRoute }).probability,
    }));

    return {
      system: SYSTEMS[system], from: fromStop, to: toStop,
      transfer: {
        type: transfer.type, fixedTimeSeconds: transfer.fixedTimeSec,
        distribution: transfer.distribution, accessibility: transfer.accessibility,
        notes: transfer.notes, source: transfer.source,
      },
      probabilities,
    };
  });

  fastify.get("/api/v1/transfers/:system/stats", async (req, reply) => {
    const { system } = req.params;
    const engine = engines.get(system);
    if (!engine) return reply.code(404).send({ error: "No engine" });
    return { system, stats: engine.getStats() };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function resolveStopIds(pg, system, stopId) {
  // Step 1: direct match + children by parent_station
  const result = await pg.query(
    `SELECT stop_id FROM gtfs_stops WHERE system_id = $1 AND (stop_id = $2 OR parent_station = $2)`,
    [system, stopId]
  );
  const ids = result.rows.map((r) => r.stop_id);
  if (ids.length > 0) {
    // Check if any of these are actually in the route graph
    const graphCheck = await pg.query(
      `SELECT DISTINCT from_stop_id FROM route_graph WHERE system_id = $1 AND from_stop_id = ANY($2) LIMIT 1`,
      [system, ids]
    );
    if (graphCheck.rows.length > 0) return ids;
  }

  // Step 2: find by stop name (for MBTA where parent linkage is broken)
  const nameResult = await pg.query(
    `SELECT stop_name FROM gtfs_stops WHERE system_id = $1 AND stop_id = $2 LIMIT 1`,
    [system, stopId]
  );
  if (nameResult.rows.length > 0) {
    const name = nameResult.rows[0].stop_name;
    const nameMatches = await pg.query(
      `SELECT s.stop_id FROM gtfs_stops s
       JOIN route_graph rg ON s.system_id = rg.system_id AND s.stop_id = rg.from_stop_id
       WHERE s.system_id = $1 AND s.stop_name = $2`,
      [system, name]
    );
    if (nameMatches.rows.length > 0) {
      return nameMatches.rows.map((r) => r.stop_id);
    }
  }

  // Step 3: rapid-transit priority name match — finds rail/subway/tram stops first.
  // Prevents bus stops with the same name (e.g. "Wonderland" bus vs Blue Line)
  // from shadowing the rapid transit stop and consuming the LIMIT.
  // Checks BOTH from_stop_id AND to_stop_id so terminal stations (e.g. Boston
  // College, which only appears as to_stop_id in route_graph) are included.
  const railNameMatch = await pg.query(
    `SELECT DISTINCT s.stop_id FROM gtfs_stops s
     JOIN gtfs_routes gr ON gr.system_id = s.system_id AND gr.route_type IN (0, 1, 2)
     WHERE s.system_id = $1 AND s.stop_name ILIKE $2
       AND (
         EXISTS (SELECT 1 FROM route_graph rg WHERE rg.system_id = $1 AND rg.route_id = gr.route_id AND rg.from_stop_id = s.stop_id)
         OR EXISTS (SELECT 1 FROM route_graph rg WHERE rg.system_id = $1 AND rg.route_id = gr.route_id AND rg.to_stop_id = s.stop_id)
       )
     ORDER BY s.stop_id LIMIT 10`,
    [system, stopId]
  );
  if (railNameMatch.rows.length > 0) {
    return railNameMatch.rows.map((r) => r.stop_id);
  }

  // Step 4: exact stop_name match (case-insensitive), any route type
  const exactNameMatch = await pg.query(
    `SELECT stop_id FROM (
       SELECT DISTINCT s.stop_id, length(s.stop_name) AS name_len
       FROM gtfs_stops s
       WHERE s.system_id = $1 AND s.stop_name ILIKE $2
         AND (
           EXISTS (SELECT 1 FROM route_graph rg WHERE rg.system_id = $1 AND rg.from_stop_id = s.stop_id)
           OR EXISTS (SELECT 1 FROM route_graph rg WHERE rg.system_id = $1 AND rg.to_stop_id = s.stop_id)
         )
     ) sub ORDER BY name_len LIMIT 10`,
    [system, stopId]
  );
  if (exactNameMatch.rows.length > 0) {
    return exactNameMatch.rows.map((r) => r.stop_id);
  }

  // Step 5: prefix match — user typed a partial name (e.g. "Norristown" matches "Norristown Transit Center")
  const prefixMatch = await pg.query(
    `SELECT stop_id FROM (
       SELECT DISTINCT s.stop_id, length(s.stop_name) AS name_len
       FROM gtfs_stops s
       WHERE s.system_id = $1 AND s.stop_name ILIKE $2
         AND (
           EXISTS (SELECT 1 FROM route_graph rg WHERE rg.system_id = $1 AND rg.from_stop_id = s.stop_id)
           OR EXISTS (SELECT 1 FROM route_graph rg WHERE rg.system_id = $1 AND rg.to_stop_id = s.stop_id)
         )
     ) sub ORDER BY name_len LIMIT 10`,
    [system, stopId + '%']
  );
  if (prefixMatch.rows.length > 0) {
    return prefixMatch.rows.map((r) => r.stop_id);
  }

  // Step 6: word-intersection match — handles abbreviations like "Norristown TC" → "Norristown Transit Center"
  //         Split on whitespace and match stops containing all significant words
  const words = stopId.split(/\s+/).filter((w) => w.length > 2);
  if (words.length > 0) {
    // $1 = system, $2...$N = word patterns
    const conditions = words.map((_, i) => `s.stop_name ILIKE $${i + 2}`).join(' AND ');
    const fuzzyMatch = await pg.query(
      `SELECT s.stop_id FROM gtfs_stops s
       JOIN route_graph rg ON s.system_id = rg.system_id AND s.stop_id = rg.from_stop_id
       WHERE s.system_id = $1 AND ${conditions}
       ORDER BY length(s.stop_name)
       LIMIT 5`,
      [system, ...words.map((w) => `%${w}%`)]
    );
    if (fuzzyMatch.rows.length > 0) {
      return fuzzyMatch.rows.map((r) => r.stop_id);
    }
  }

  return ids.length > 0 ? ids : [stopId];
}

async function estimateRideTime(pg, system, routeId, fromStops, toStops) {
  try {
    // Method 1: direct stop_times lookup (fastest, most accurate)
    const result = await pg.query(`
      SELECT MIN(arrive_sec - depart_sec) AS travel_sec
      FROM (
        SELECT
          (SPLIT_PART(st1.departure_time,':',1)::int*3600 +
           SPLIT_PART(st1.departure_time,':',2)::int*60 +
           SPLIT_PART(st1.departure_time,':',3)::int) AS depart_sec,
          (SPLIT_PART(st2.arrival_time,':',1)::int*3600 +
           SPLIT_PART(st2.arrival_time,':',2)::int*60 +
           SPLIT_PART(st2.arrival_time,':',3)::int) AS arrive_sec
        FROM gtfs_stop_times st1
        JOIN gtfs_stop_times st2
          ON st1.system_id = st2.system_id
          AND st1.trip_id = st2.trip_id
          AND st2.stop_sequence > st1.stop_sequence
        JOIN gtfs_trips t
          ON st1.system_id = t.system_id AND st1.trip_id = t.trip_id
        WHERE st1.system_id = $1
          AND t.route_id = $2
          AND st1.stop_id = ANY($3)
          AND st2.stop_id = ANY($4)
          AND st1.departure_time ~ '^\d+:\d+:\d+$'
          AND st2.arrival_time ~ '^\d+:\d+:\d+$'
        LIMIT 20
      ) sub
      WHERE arrive_sec > depart_sec
    `, [system, routeId, fromStops, toStops]);

    if (result.rows[0]?.travel_sec) return result.rows[0].travel_sec;

    // Method 2: recursive graph traversal with cycle detection
    // Route graphs have bidirectional edges (trains run both ways), so we must
    // track visited stops to prevent exponential blow-up.
    const graphResult = await pg.query(`
      WITH RECURSIVE path AS (
        SELECT from_stop_id, to_stop_id,
               avg_travel_seconds AS total_sec,
               1 AS hops,
               ARRAY[from_stop_id] AS visited
        FROM route_graph
        WHERE system_id = $1 AND route_id = $2 AND from_stop_id = ANY($3)
        UNION ALL
        SELECT rg.from_stop_id, rg.to_stop_id,
               p.total_sec + rg.avg_travel_seconds,
               p.hops + 1,
               p.visited || rg.from_stop_id
        FROM route_graph rg
        JOIN path p ON rg.from_stop_id = p.to_stop_id
        WHERE rg.system_id = $1 AND rg.route_id = $2
          AND p.hops < 30
          AND NOT (rg.from_stop_id = ANY(p.visited))
      )
      SELECT MIN(total_sec) AS travel_sec
      FROM path WHERE to_stop_id = ANY($4)
    `, [system, routeId, fromStops, toStops]);

    return graphResult.rows[0]?.travel_sec || 300;
  } catch {
    return 300;
  }
}

async function getRouteInfo(pg, system, routeId) {
  try {
    const result = await pg.query(
      `SELECT route_short_name, route_long_name, route_color
       FROM gtfs_routes WHERE system_id = $1 AND route_id = $2 LIMIT 1`,
      [system, routeId]
    );
    if (result.rows.length === 0) return { name: routeId, color: "#888888" };
    const r = result.rows[0];
    return { name: r.route_short_name || r.route_long_name || routeId, color: r.route_color ? `#${r.route_color}` : "#888888" };
  } catch {
    return { name: routeId, color: "#888888" };
  }
}

async function getStopName(pg, system, stopId) {
  try {
    // Try to get the parent station name (more user-friendly)
    const result = await pg.query(
      `SELECT s.stop_name, p.stop_name AS parent_name
       FROM gtfs_stops s
       LEFT JOIN gtfs_stops p ON s.system_id = p.system_id AND s.parent_station = p.stop_id
       WHERE s.system_id = $1 AND s.stop_id = $2 LIMIT 1`,
      [system, stopId]
    );
    return result.rows[0]?.parent_name || result.rows[0]?.stop_name || stopId;
  } catch {
    return stopId;
  }
}

function walkTimeSec(pace) {
  return { slow: 360, average: 240, fast: 150 }[pace] || 240;
}
