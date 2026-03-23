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
        )
        SELECT DISTINCT ON (fr.route_id, tr.route_id)
          fr.route_id AS route1,
          tr.route_id AS route2,
          rg1.to_stop_id AS transfer_stop
        FROM from_routes fr
        JOIN route_graph rg1 ON rg1.system_id = $1 AND rg1.route_id = fr.route_id
        JOIN route_graph rg2 ON rg2.system_id = $1 AND rg1.to_stop_id = rg2.from_stop_id
        JOIN to_routes tr ON rg2.route_id = tr.route_id
        WHERE fr.route_id != tr.route_id
        LIMIT 10
      `, [system, fromStops, toStops]);

      for (const row of transferResult.rows) {
        const route1Info = await getRouteInfo(pg, system, row.route1);
        const route2Info = await getRouteInfo(pg, system, row.route2);
        const transferStopName = await getStopName(pg, system, row.transfer_stop);
        const walkSec = walkTimeSec(walkingPace);

        const ride1Sec = await estimateRideTime(pg, system, row.route1, fromStops, [row.transfer_stop]);
        const ride2Sec = await estimateRideTime(pg, system, row.route2, [row.transfer_stop], toStops);

        let transferInfo = { probability: 0.75, transferTime: 120, type: "unknown", notes: null, accessibility: null };
        if (engine) {
          transferInfo = engine.calculateConnectionProbability(
            row.transfer_stop, row.transfer_stop, 180,
            { fromRouteId: row.route1, toRouteId: row.route2, rushHour, walkingPace }
          );
        }

        const totalSec = walkSec + ride1Sec + transferInfo.transferTime + ride2Sec;

        routes.push({
          id: `transfer-${row.route1}-${row.route2}-${row.transfer_stop}`,
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
              from, to: row.transfer_stop,
              durationSec: ride1Sec, durationMin: Math.round(ride1Sec / 60),
              direction: "", isRealtime: false,
            },
            {
              type: "transfer", station: transferStopName, stationId: row.transfer_stop,
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
              from: row.transfer_stop, to,
              durationSec: ride2Sec, durationMin: Math.round(ride2Sec / 60),
              direction: "", isRealtime: false,
            },
          ],
        });
      }
    } catch (err) {
      fastify.log.debug({ err: err.message }, "Transfer route query failed");
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
  const result = await pg.query(
    `SELECT stop_id FROM gtfs_stops WHERE system_id = $1 AND (stop_id = $2 OR parent_station = $2)`,
    [system, stopId]
  );
  const ids = result.rows.map((r) => r.stop_id);
  return ids.length > 0 ? ids : [stopId];
}

async function estimateRideTime(pg, system, routeId, fromStops, toStops) {
  try {
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

    return result.rows[0]?.travel_sec || 300;
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
    const result = await pg.query(
      `SELECT stop_name FROM gtfs_stops WHERE system_id = $1 AND stop_id = $2 LIMIT 1`,
      [system, stopId]
    );
    return result.rows[0]?.stop_name || stopId;
  } catch {
    return stopId;
  }
}

function walkTimeSec(pace) {
  return { slow: 360, average: 240, fast: 150 }[pace] || 240;
}
