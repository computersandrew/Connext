// packages/api/src/routes/planner.js
import { SYSTEMS } from "../config.js";
import { getFareForRoute } from "./fares.js";

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
    const { from, to, depart, pace, lat, lng, walkDistKm } = req.query;

    if (!SYSTEMS[system]) return reply.code(404).send({ error: "SYSTEM_NOT_FOUND" });
    if (!from || !to) return reply.code(400).send({ error: "MISSING_PARAMS", message: "Both 'from' and 'to' required" });
    if (!pg) return reply.code(503).send({ error: "DB_UNAVAILABLE" });

    const engine = engines.get(system);
    const now = Math.floor(Date.now() / 1000);
    const walkingPace = pace || "average";
    const walkDistKmNum = walkDistKm != null ? parseFloat(walkDistKm) : null;
    const hour = new Date().getHours();
    const rushHour = (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19);

    // Build a human-readable walk description from real distance if available
    const walkDesc = walkDistKmNum != null
      ? walkDistKmNum < 0.1
        ? `Walk ${Math.round(walkDistKmNum * 1000)}m to stop`
        : `Walk ${walkDistKmNum.toFixed(2)}km to stop`
      : "Walk to stop";

    // Seconds since midnight — used to find real schedule buffer at transfer points
    const nowDate = new Date();
    const secSinceMidnight = nowDate.getHours() * 3600 + nowDate.getMinutes() * 60 + nowDate.getSeconds();

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
        const walkSec = walkTimeSec(walkingPace, walkDistKmNum);

        routes.push({
          id: `direct-${row.route_id}`,
          type: "direct",
          totalTimeSec: walkSec + rideSec,
          totalTimeMin: Math.round((walkSec + rideSec) / 60),
          transfers: 0,
          overallProbability: null,
          leaveBy: new Date((now - walkSec) * 1000).toISOString(),
          legs: [
            { type: "walk", durationSec: walkSec, durationMin: Math.round(walkSec / 60), description: walkDesc, distanceKm: walkDistKmNum ?? null },
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
            -- Group by parent_station when set (MBTA).
            -- Fall back to stop_name so same-named stops across different lines
            -- (e.g. SEPTA "15th St/City Hall" on BSL and MFL) are treated as one station.
            COALESCE(NULLIF(s.parent_station, ''), s.stop_name) AS station_id,
            rg.route_id,
            ARRAY_AGG(DISTINCT rg.from_stop_id) AS stop_ids,
            MIN(rg.from_stop_id) AS rep_stop_id
          FROM route_graph rg
          JOIN gtfs_stops s ON s.system_id = $1 AND s.stop_id = rg.from_stop_id
          WHERE rg.system_id = $1
          GROUP BY COALESCE(NULLIF(s.parent_station, ''), s.stop_name), rg.route_id
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
        const walkSec = walkTimeSec(walkingPace, walkDistKmNum);

        // Each leg uses the correct stop-ID array for its route at the transfer station:
        //   Leg 1: origin → route1's stops at the transfer station
        //   Leg 2: route2's stops at the transfer station → destination
        const ride1Sec = await estimateRideTime(pg, system, row.route1, fromStops, row.stops_r1);
        const ride2Sec = await estimateRideTime(pg, system, row.route2, row.stops_r2, toStops);

        let transferInfo = { probability: 0.75, transferTime: 120, type: "unknown", notes: null, accessibility: null };
        if (engine) {
          // First pass with default buffer to get the transfer's minimum time
          const defaultInfo = engine.calculateConnectionProbability(
            row.transfer_rep, row.transfer_rep, 180,
            { fromRouteId: row.route1, toRouteId: row.route2, rushHour, walkingPace }
          );
          // Compute real buffer: how long until route2 departs after we arrive
          const estimatedArrival = secSinceMidnight + walkSec + ride1Sec;
          const scheduleBuf = await getScheduleBuffer(
            pg, system, row.route2, row.stops_r2, estimatedArrival, defaultInfo.transferTime
          );
          const bufferSec = scheduleBuf ?? 180;
          transferInfo = engine.calculateConnectionProbability(
            row.transfer_rep, row.transfer_rep, bufferSec,
            { fromRouteId: row.route1, toRouteId: row.route2, rushHour, walkingPace }
          );
          transferInfo._bufferSec = bufferSec;  // carry through for display
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
            { type: "walk", durationSec: walkSec, durationMin: Math.round(walkSec / 60), description: walkDesc, distanceKm: walkDistKmNum ?? null },
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
              bufferSec: transferInfo._bufferSec ?? 180,
              bufferMin: Math.round((transferInfo._bufferSec ?? 180) / 60),
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
    // For rail systems (MBTA, SEPTA): only considers rail routes to prevent explosion.
    // For pure-bus systems (CDTA): uses middle_routes pre-filter to avoid scanning
    // all 69 routes × all stops. Only routes that serve stops of BOTH from_routes
    // AND to_routes are considered as middle routes — drastically cuts route_xfers size.
    // Uses parent_station grouping for agencies with split inbound/outbound stop IDs.
    try {
      const twoXferResult = await pg.query(`
        WITH
        -- For systems with rapid-transit (MBTA, SEPTA), restrict two-transfer planning
        -- to rail routes to avoid a combinatorial explosion of bus-bus combinations.
        -- For pure-bus systems (CDTA), fall back to all routes so transfers work at all.
        rail_routes AS (
          SELECT route_id FROM gtfs_routes
          WHERE system_id = $1 AND route_type IN (0, 1, 2)
          UNION ALL
          SELECT route_id FROM gtfs_routes
          WHERE system_id = $1 AND route_type = 3
            AND NOT EXISTS (
              SELECT 1 FROM gtfs_routes WHERE system_id = $1 AND route_type IN (0, 1, 2)
            )
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
        -- Station keys visited by from_routes — used to identify middle-leg candidates.
        -- Uses stop_name fallback (same as route_station_stops) so that agencies with
        -- different stop IDs for the same physical station still match (e.g. SEPTA
        -- BSL stop 15497 and MFL stop 416 both named "69th St Transit Center").
        from_station_keys AS (
          SELECT DISTINCT COALESCE(NULLIF(s.parent_station, ''), s.stop_name) AS station_key
          FROM route_graph rg
          JOIN from_routes fr ON rg.route_id = fr.route_id
          JOIN gtfs_stops s ON s.system_id = $1 AND s.stop_id = rg.from_stop_id
          WHERE rg.system_id = $1
        ),
        -- Station keys visited by to_routes.
        to_station_keys AS (
          SELECT DISTINCT COALESCE(NULLIF(s.parent_station, ''), s.stop_name) AS station_key
          FROM route_graph rg
          JOIN to_routes tr ON rg.route_id = tr.route_id
          JOIN gtfs_stops s ON s.system_id = $1 AND s.stop_id = rg.from_stop_id
          WHERE rg.system_id = $1
        ),
        -- Routes that touch at least one station shared with from_routes AND at least
        -- one station shared with to_routes. Uses station-name matching so that routes
        -- connecting at the same physical station (different stop IDs) are included.
        middle_routes AS (
          SELECT DISTINCT rg.route_id
          FROM route_graph rg
          JOIN gtfs_stops s ON s.system_id = $1 AND s.stop_id = rg.from_stop_id
          WHERE rg.system_id = $1
            AND COALESCE(NULLIF(s.parent_station, ''), s.stop_name) IN (SELECT station_key FROM from_station_keys)
          INTERSECT
          SELECT DISTINCT rg.route_id
          FROM route_graph rg
          JOIN gtfs_stops s ON s.system_id = $1 AND s.stop_id = rg.from_stop_id
          WHERE rg.system_id = $1
            AND COALESCE(NULLIF(s.parent_station, ''), s.stop_name) IN (SELECT station_key FROM to_station_keys)
        ),
        -- Only build route_station_stops for the small set of relevant routes:
        -- from_routes + to_routes + middle_routes.  Excludes the vast majority of
        -- routes that can never appear in a valid two-transfer path.
        relevant_routes AS (
          SELECT route_id FROM from_routes
          UNION SELECT route_id FROM to_routes
          UNION SELECT route_id FROM middle_routes
        ),
        -- Stops grouped by (physical_station, route) — only for relevant routes.
        -- Fall back to stop_name so same-named stops on different lines at the
        -- same station (e.g. SEPTA BSL and MFL at "15th St/City Hall") group together.
        route_station_stops AS (
          SELECT
            COALESCE(NULLIF(s.parent_station, ''), s.stop_name) AS station_id,
            rg.route_id,
            ARRAY_AGG(DISTINCT rg.from_stop_id) AS stop_ids,
            MIN(rg.from_stop_id) AS rep_stop_id   -- representative ID for display
          FROM route_graph rg
          JOIN relevant_routes rr ON rg.route_id = rr.route_id
          JOIN gtfs_stops s ON s.system_id = $1 AND s.stop_id = rg.from_stop_id
          WHERE rg.system_id = $1
          GROUP BY COALESCE(NULLIF(s.parent_station, ''), s.stop_name), rg.route_id
        ),
        -- Transfer pairs among relevant routes sharing a physical station.
        -- station_id is propagated so two_xfer can enforce distinct transfer stations.
        route_xfers AS (
          SELECT DISTINCT
            rss1.station_id  AS station_id,
            rss1.route_id    AS route_a,
            rss1.stop_ids    AS stops_a,
            rss1.rep_stop_id AS rep_a,
            rss2.route_id    AS route_b,
            rss2.stop_ids    AS stops_b,
            rss2.rep_stop_id AS rep_b
          FROM route_station_stops rss1
          JOIN route_station_stops rss2
            ON rss1.station_id = rss2.station_id AND rss1.route_id != rss2.route_id
        ),
        -- Two-transfer paths: route1 → station1 → route2 → station2 → route3
        two_xfer AS (
          SELECT DISTINCT
            rx1.route_a    AS route1,
            rx1.stops_a    AS t1_stops_r1,
            rx1.rep_a      AS t1_rep,
            rx1.route_b    AS route2,
            rx1.stops_b    AS t1_stops_r2,
            rx2.stops_a    AS t2_stops_r2,
            rx2.rep_a      AS t2_rep,
            rx2.route_b    AS route3,
            rx2.stops_b    AS t2_stops_r3
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
        ORDER BY route1, route2, route3
        LIMIT 60
      `, [system, fromStops, toStops]);

      if (twoXferResult.rows.length > 0) {
        // Batch-fetch all route infos and stop names in two queries up front.
        // This avoids N×getRouteInfo + N×getStopName round-trips inside the loop.
        const routeIds = [...new Set(twoXferResult.rows.flatMap(r => [r.route1, r.route2, r.route3]))];
        const stopIds  = [...new Set(twoXferResult.rows.flatMap(r => [r.t1_rep, r.t2_rep]))];

        const [routeInfosRes, stopNamesRes] = await Promise.all([
          pg.query(
            `SELECT route_id, route_short_name, route_long_name, route_color
             FROM gtfs_routes WHERE system_id=$1 AND route_id=ANY($2)`,
            [system, routeIds]
          ),
          pg.query(
            `SELECT stop_id, stop_name FROM gtfs_stops WHERE system_id=$1 AND stop_id=ANY($2)`,
            [system, stopIds]
          ),
        ]);

        const routeInfoCache = new Map(
          routeInfosRes.rows.map(r => [r.route_id, {
            name: r.route_short_name || r.route_long_name || r.route_id,
            color: r.route_color ? `#${r.route_color}` : "#888888",
          }])
        );
        const stopNameCache = new Map(stopNamesRes.rows.map(r => [r.stop_id, r.stop_name]));

        // Process all combos in parallel — estimateRideTime calls are concurrent
        // across combos, limited naturally by the database connection pool.
        const walkSec = walkTimeSec(walkingPace, walkDistKmNum);

        const comboResults = await Promise.all(twoXferResult.rows.map(async (row) => {
          const [ride1Sec, ride2Sec, ride3Sec] = await Promise.all([
            estimateRideTime(pg, system, row.route1, fromStops, row.t1_stops_r1),
            estimateRideTime(pg, system, row.route2, row.t1_stops_r2, row.t2_stops_r2),
            estimateRideTime(pg, system, row.route3, row.t2_stops_r3, toStops),
          ]);

          // Skip combos where any leg has only a fallback time — those stop
          // combinations are directionally invalid (wrong-side-of-street stop).
          if (ride1Sec === 300 || ride2Sec === 300 || ride3Sec === 300) return null;

          const r1Info = routeInfoCache.get(row.route1) || { name: row.route1, color: "#888888" };
          const r2Info = routeInfoCache.get(row.route2) || { name: row.route2, color: "#888888" };
          const r3Info = routeInfoCache.get(row.route3) || { name: row.route3, color: "#888888" };
          const t1Name = stopNameCache.get(row.t1_rep) || row.t1_rep;
          const t2Name = stopNameCache.get(row.t2_rep) || row.t2_rep;

          let xfer1Info = { probability: 0.75, transferTime: 120, type: "unknown", notes: null, accessibility: null };
          let xfer2Info = { probability: 0.75, transferTime: 120, type: "unknown", notes: null, accessibility: null };
          if (engine) {
            // Transfer 1: after ride1
            const defaultX1 = engine.calculateConnectionProbability(row.t1_rep, row.t1_rep, 180, { fromRouteId: row.route1, toRouteId: row.route2, rushHour, walkingPace });
            const arr1 = secSinceMidnight + walkSec + ride1Sec;
            const buf1 = (await getScheduleBuffer(pg, system, row.route2, row.t1_stops_r2, arr1, defaultX1.transferTime)) ?? 180;
            xfer1Info = engine.calculateConnectionProbability(row.t1_rep, row.t1_rep, buf1, { fromRouteId: row.route1, toRouteId: row.route2, rushHour, walkingPace });
            xfer1Info._bufferSec = buf1;

            // Transfer 2: after ride1 + xfer1 wait + ride2
            const arr2 = arr1 + buf1 + ride2Sec;
            const defaultX2 = engine.calculateConnectionProbability(row.t2_rep, row.t2_rep, 180, { fromRouteId: row.route2, toRouteId: row.route3, rushHour, walkingPace });
            const buf2 = (await getScheduleBuffer(pg, system, row.route3, row.t2_stops_r3, arr2, defaultX2.transferTime)) ?? 180;
            xfer2Info = engine.calculateConnectionProbability(row.t2_rep, row.t2_rep, buf2, { fromRouteId: row.route2, toRouteId: row.route3, rushHour, walkingPace });
            xfer2Info._bufferSec = buf2;
          }

          const totalSec = walkSec + ride1Sec + xfer1Info.transferTime + ride2Sec + xfer2Info.transferTime + ride3Sec;
          const overallProb = xfer1Info.probability * xfer2Info.probability;

          return {
            id: `transfer2-${row.route1}-${row.route2}-${row.route3}-${row.t1_rep}-${row.t2_rep}`,
            type: "two_transfers",
            totalTimeSec: totalSec,
            totalTimeMin: Math.round(totalSec / 60),
            transfers: 2,
            overallProbability: overallProb,
            leaveBy: new Date((now - walkSec) * 1000).toISOString(),
            legs: [
              { type: "walk", durationSec: walkSec, durationMin: Math.round(walkSec / 60), description: walkDesc, distanceKm: walkDistKmNum ?? null },
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
                bufferSec: xfer1Info._bufferSec ?? 180, bufferMin: Math.round((xfer1Info._bufferSec ?? 180) / 60),
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
                bufferSec: xfer2Info._bufferSec ?? 180, bufferMin: Math.round((xfer2Info._bufferSec ?? 180) / 60),
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
          };
        }));

        // Filter nulls (invalid combos) and add to routes
        for (const r of comboResults) {
          if (r !== null) routes.push(r);
        }
      }
    } catch (err) {
      fastify.log.debug({ err: err.message }, "Two-transfer route query failed");
    }

    // ─── Extended walk: direct routes from stops within walking distance ────
    // Finds stops you could walk to (up to 20 min) that have a direct route
    // to the destination — e.g. "walk 17 min to Hynes, board Green-B direct".
    const userLat = lat ? parseFloat(lat) : null;
    const userLng = lng ? parseFloat(lng) : null;
    const MAX_WALK_MIN = 20;
    const WALK_SPEED_KMH = { slow: 4.0, average: 5.0, fast: 6.5 }[walkingPace] || 5.0;
    const MAX_WALK_KM = (MAX_WALK_MIN / 60) * WALK_SPEED_KMH; // ~1.67km at average

    if (userLat && userLng) {
      try {
        // Find stops within walking distance that share a route with the destination
        // but are NOT already the origin (avoid re-suggesting the same stop)
        const walkableResult = await pg.query(`
          WITH dest_routes AS (
            SELECT DISTINCT route_id
            FROM route_graph
            WHERE system_id = $1 AND to_stop_id = ANY($2)
          ),
          nearby AS (
            SELECT s.stop_id, s.stop_name, s.stop_lat, s.stop_lon,
              (6371 * 2 * asin(sqrt(
                power(sin(radians((s.stop_lat - $3) / 2)), 2) +
                cos(radians($3)) * cos(radians(s.stop_lat)) *
                power(sin(radians((s.stop_lon - $4) / 2)), 2)
              ))) AS dist_km
            FROM gtfs_stops s
            WHERE s.system_id = $1
              AND s.stop_lat IS NOT NULL
              AND s.stop_lat BETWEEN $3 - 0.03 AND $3 + 0.03
              AND s.stop_lon BETWEEN $4 - 0.04 AND $4 + 0.04
          ),
          walkable AS (
            SELECT * FROM nearby WHERE dist_km <= $5 AND stop_id != ANY($6)
          )
          SELECT DISTINCT w.stop_id, w.stop_name, w.dist_km, rg.route_id
          FROM walkable w
          JOIN route_graph rg ON rg.system_id = $1 AND rg.from_stop_id = w.stop_id
          JOIN dest_routes dr ON dr.route_id = rg.route_id
          ORDER BY w.dist_km, rg.route_id
          LIMIT 20
        `, [system, toStops, userLat, userLng, MAX_WALK_KM, fromStops]);

        // Track routes already added so we pick the closest VALID (correct-direction)
        // stop for each route and don't add the same route twice.
        const seenWalkRoutes = new Set();
        for (const row of walkableResult.rows) {
          if (seenWalkRoutes.has(row.route_id)) continue;

          const walkKm = parseFloat(row.dist_km);
          const rawWalkSec = (walkKm / WALK_SPEED_KMH) * 3600;
          const walkSec = Math.max(60, Math.round(rawWalkSec / 15) * 15);
          if (walkSec > MAX_WALK_MIN * 60) continue;

          const rideSec = await estimateRideTime(pg, system, row.route_id, [row.stop_id], toStops);
          // 300s is the hardcoded fallback — it means no trip data was found for this
          // stop → destination combination, which happens when the stop is directionally
          // wrong (e.g. inbound platform going away from the destination).  Skip and
          // let the loop try the next candidate stop for the same route.
          if (rideSec === 300) continue;

          seenWalkRoutes.add(row.route_id);
          const routeInfo = await getRouteInfo(pg, system, row.route_id);
          const totalSec = walkSec + rideSec;

          routes.push({
            id: `walk-direct-${row.stop_id}-${row.route_id}`,
            type: "walk_direct",
            totalTimeSec: totalSec,
            totalTimeMin: Math.round(totalSec / 60),
            transfers: 0,
            overallProbability: null,
            leaveBy: new Date((now - walkSec) * 1000).toISOString(),
            legs: [
              {
                type: "walk",
                durationSec: walkSec,
                durationMin: Math.round(walkSec / 60),
                description: `Walk ${walkKm.toFixed(1)}km to ${row.stop_name}`,
                distanceKm: walkKm,
              },
              {
                type: "ride",
                routeId: row.route_id,
                routeName: routeInfo.name,
                routeColor: routeInfo.color,
                from: row.stop_id,
                to,
                durationSec: rideSec,
                durationMin: Math.round(rideSec / 60),
                direction: "",
                isRealtime: false,
              },
            ],
          });
        }
      } catch (err) {
        fastify.log.debug({ err: err.message }, "Extended walk query failed");
      }
    }

    // ─── Attach fare estimates to every route ─────────────────────────────────
    // Collect unique route IDs across all built routes, fetch fares in parallel,
    // then annotate each route with a totalFare field.
    try {
      const allRouteIds = [...new Set(
        routes.flatMap((r) => r.legs.filter((l) => l.type === "ride").map((l) => l.routeId))
      )];
      const fareMap = new Map();
      await Promise.all(allRouteIds.map(async (rid) => {
        const f = await getFareForRoute(pg, system, rid, fastify.log);
        fareMap.set(rid, f);
      }));

      for (const route of routes) {
        const rideLegs = route.legs.filter((l) => l.type === "ride");
        if (rideLegs.length === 0) { route.fare = null; continue; }

        // Compute total fare: if transfers are included (unlimited or count ≥ legs-1),
        // charge only the first leg; otherwise sum each leg's fare.
        const fares = rideLegs.map((l) => fareMap.get(l.routeId)).filter(Boolean);
        if (fares.length === 0) { route.fare = null; continue; }

        const firstFare = fares[0];
        const transfersFree = firstFare.transfersIncluded === "unlimited" ||
          (typeof firstFare.transfersIncluded === "number" && firstFare.transfersIncluded >= rideLegs.length - 1);

        let totalPrice;
        if (transfersFree) {
          // Single fare covers the whole trip
          totalPrice = firstFare.price;
        } else {
          // Sum each leg (simplified — zone-based rail may vary)
          const prices = fares.map((f) => f.price).filter((p) => p !== null);
          totalPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) : null;
        }

        const currency = firstFare.currency || "USD";
        route.fare = {
          price: totalPrice !== null ? Math.round(totalPrice * 100) / 100 : null,
          currency,
          label: totalPrice !== null
            ? new Intl.NumberFormat("en-US", { style: "currency", currency }).format(totalPrice)
            : fares.some((f) => f.label === "Zone fare" || f.label === "Varies") ? "Zone fare" : null,
          transfersFree,
          source: firstFare.source,
        };
      }
    } catch (err) {
      fastify.log.debug({ err: err.message }, "Fare annotation failed (non-fatal)");
    }

    // Sort and deduplicate
    routes.sort((a, b) => a.totalTimeSec - b.totalTimeSec);
    const seen = new Set();
    const unique = routes.filter((r) => {
      const rideLegs = r.legs.filter((l) => l.routeId);
      const transferLegs = r.legs.filter((l) => l.type === "transfer");
      // Key: first route + transfer station(s) + total time bucket (±1 min)
      // This merges "39→N via Back Bay" and "39→F via Back Bay" since
      // the user just needs to know "take the 39 to Back Bay, catch any commuter rail"
      const firstRoute = rideLegs[0]?.routeId ?? "";
      const transferStops = transferLegs.map((l) => l.stopId ?? l.description ?? "").join("|");
      const timeBucket = Math.round(r.totalTimeSec / 60);
      const key = `${firstRoute}::${transferStops}::${timeBucket}`;
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

/**
 * Find how many seconds until the next departure of routeId from any of transferStopIds,
 * given that we expect to arrive at the transfer station at estimatedArrivalSec
 * (seconds since midnight) and need at least minTransferSec to make the connection.
 *
 * Returns the total buffer (next_departure - arrival), or null if schedule data
 * is unavailable (caller should fall back to a default).
 */
async function getScheduleBuffer(pg, system, routeId, transferStopIds, estimatedArrivalSec, minTransferSec) {
  try {
    const earliest = estimatedArrivalSec + minTransferSec;

    const [tripRes, depRes] = await Promise.all([
      pg.query('SELECT trip_id FROM gtfs_trips WHERE system_id=$1 AND route_id=$2', [system, routeId]),
      pg.query(
        'SELECT trip_id, departure_time FROM gtfs_stop_times WHERE system_id=$1 AND stop_id=ANY($2) LIMIT 3000',
        [system, transferStopIds]
      ),
    ]);

    if (tripRes.rows.length === 0) return null;
    const tripSet = new Set(tripRes.rows.map(r => r.trip_id));

    const toSec = t => {
      const [h, m, s] = t.split(':').map(Number);
      return h * 3600 + m * 60 + s;
    };

    let nextDep = Infinity;
    for (const r of depRes.rows) {
      if (!tripSet.has(r.trip_id) || !r.departure_time) continue;
      const depSec = toSec(r.departure_time);
      // Also check next-day wrap (GTFS times can exceed 24h for overnight schedules)
      for (const candidate of [depSec, depSec + 86400]) {
        if (candidate >= earliest && candidate < nextDep) nextDep = candidate;
      }
    }

    if (nextDep === Infinity) return null;

    // Buffer = time from when we arrive at the station to when the next train/bus leaves
    // Cap at 30 min — longer waits should still show as long but won't skew probability
    const buffer = Math.min(nextDep - estimatedArrivalSec, 1800);
    return buffer > 0 ? buffer : null;
  } catch {
    return null;
  }
}

async function estimateRideTime(pg, system, routeId, fromStops, toStops) {
  // Fast JS approach: 3 parallel queries + in-memory join.
  // Avoids the bad nested-loop query plans that PostgreSQL generates when
  // joining gtfs_stop_times to gtfs_trips via a CTE subquery.  Each query
  // uses the (system_id, stop_id) prefix of idx_stop_times_stop_trip and
  // the in-memory join handles directionality via arr_sec > dep_sec.
  try {
    const [tripRes, depRes, arrRes] = await Promise.all([
      pg.query(
        'SELECT trip_id FROM gtfs_trips WHERE system_id=$1 AND route_id=$2',
        [system, routeId]
      ),
      pg.query(
        'SELECT trip_id, departure_time FROM gtfs_stop_times WHERE system_id=$1 AND stop_id=ANY($2) LIMIT 5000',
        [system, fromStops]
      ),
      pg.query(
        'SELECT trip_id, arrival_time FROM gtfs_stop_times WHERE system_id=$1 AND stop_id=ANY($2) LIMIT 5000',
        [system, toStops]
      ),
    ]);

    const tripSet = new Set(tripRes.rows.map(r => r.trip_id));
    const toSec = t => {
      const [h, m, s] = t.split(':').map(Number);
      return h * 3600 + m * 60 + s;
    };

    // Build a map of trip_id → earliest departure time at fromStops
    const depMap = new Map();
    for (const r of depRes.rows) {
      if (!tripSet.has(r.trip_id) || !r.departure_time) continue;
      const sec = toSec(r.departure_time);
      const cur = depMap.get(r.trip_id);
      if (cur === undefined || sec < cur) depMap.set(r.trip_id, sec);
    }

    // Collect all valid travel times (arr_sec > dep_sec ensures correct direction)
    const times = [];
    for (const r of arrRes.rows) {
      if (!tripSet.has(r.trip_id) || !r.arrival_time) continue;
      const depSec = depMap.get(r.trip_id);
      if (depSec === undefined) continue;
      const arrSec = toSec(r.arrival_time);
      if (arrSec > depSec) times.push(arrSec - depSec);
    }

    if (times.length === 0) return 300;

    // Use the median rather than the minimum — the minimum picks the fastest
    // possible scheduled run, which systematically underestimates typical
    // journey time. The median gives a realistic mid-of-day estimate.
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
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

// Walking speeds in km/h: slow ~4, average ~5, fast ~6.5
const WALK_SPEED_KMH = { slow: 4.0, average: 5.0, fast: 6.5 };
// Minimum walk time even if you're standing at the stop (boarding/platform time)
const MIN_WALK_SEC = 60;

function walkTimeSec(pace, distKm = null) {
  const speedKmH = WALK_SPEED_KMH[pace] || WALK_SPEED_KMH.average;
  if (distKm != null && !isNaN(distKm) && distKm >= 0) {
    // Real distance → real walk time, rounded to nearest 15 seconds
    const rawSec = (distKm / speedKmH) * 3600;
    return Math.max(MIN_WALK_SEC, Math.round(rawSec / 15) * 15);
  }
  // Fallback when no GPS distance provided (legacy flat estimates)
  return { slow: 360, average: 240, fast: 150 }[pace] || 240;
}
