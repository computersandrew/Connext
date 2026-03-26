// packages/api/src/routes/departures.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/departures/:system/:stop          — next departures at a stop
// GET /api/v1/departures/:system                — all departure keys (debug)
// WS  /ws/departures/:system/:stop              — live countdown stream
// ─────────────────────────────────────────────────────────────────────────────

import { getJSON, getKeys, getMultiJSON } from "../redis.js";
import { SYSTEMS } from "../config.js";

// Cache of parent → child stop mappings
const childStopCache = new Map();

async function getChildStops(pg, system, stopId) {
  if (!pg) return [stopId];

  const cacheKey = `${system}:${stopId}`;
  if (childStopCache.has(cacheKey)) return childStopCache.get(cacheKey);

  try {
    const result = await pg.query(
      `SELECT stop_id FROM gtfs_stops
       WHERE system_id = $1 AND (parent_station = $2 OR stop_id = $2)`,
      [system, stopId]
    );
    const ids = result.rows.map((r) => r.stop_id);
    // Include the original ID too
    const allIds = [...new Set([stopId, ...ids])];
    childStopCache.set(cacheKey, allIds);
    return allIds;
  } catch {
    return [stopId];
  }
}

async function findDepartures(system, stopId, pg) {
  // 1. Try exact match first
  let departures = await getJSON(`departures:${system}:${stopId}`);
  if (departures && departures.length > 0) return departures;

  // 2. Try station name key
  departures = await getJSON(`departures:${system}:station:${stopId}`);
  if (departures && departures.length > 0) return departures;

  // 3. Resolve parent station to child stops and check all
  const childIds = await getChildStops(pg, system, stopId);
  if (childIds.length > 1) {
    const keys = childIds.map((id) => `departures:${system}:${id}`);
    const results = await getMultiJSON(keys);
    const all = results.flat().filter(Boolean);
    if (all.length > 0) return all;
  }
  
  // 4. Try looking up the stop name and searching by station name key
  if (pg) {
    try {
      const nameResult = await pg.query(
        `SELECT stop_name FROM gtfs_stops WHERE system_id = $1 AND stop_id = $2 LIMIT 1`,
        [system, stopId]
      );
      if (nameResult.rows.length > 0) {
        const stationKey = nameResult.rows[0].stop_name.replace(/\s+/g, "_").toLowerCase();
        const stationDeps = await getJSON(`departures:${system}:station:${stationKey}`);
        if (stationDeps && stationDeps.length > 0) return stationDeps;
      }
    } catch {}
  }
  // 4. Fuzzy: search Redis keys containing this stop ID
  const keys = await getKeys(`departures:${system}:*${stopId}*`);
  if (keys.length > 0) {
    const results = await getMultiJSON(keys);
    return results.flat().filter(Boolean);
  }

  // Fallback: schedule-based departures from stop_times (for static-only systems like CDTA)
  if (pg) {
    try {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:00`;
      const result = await pg.query(`
        SELECT st.trip_id, st.stop_id, st.departure_time, t.route_id, t.trip_headsign
        FROM gtfs_stop_times st
        JOIN gtfs_trips t ON st.system_id = t.system_id AND st.trip_id = t.trip_id
        WHERE st.system_id = $1 AND st.stop_id = $2
          AND st.departure_time >= $3
        ORDER BY st.departure_time
        LIMIT 15
      `, [system, stopId, currentTime]);

      if (result.rows.length > 0) {
        // Batch-fetch route info
        const routeIds = [...new Set(result.rows.map(r => r.route_id))];
        const routeResult = await pg.query(
          `SELECT route_id, route_short_name, route_long_name, route_color
           FROM gtfs_routes WHERE system_id = $1 AND route_id = ANY($2)`,
          [system, routeIds]
        );
        const routeMap = {};
        for (const r of routeResult.rows) {
          routeMap[r.route_id] = r;
        }

        const deps = result.rows.map(row => {
          const [h,m,s] = row.departure_time.split(':').map(Number);
          const dep = new Date(now); dep.setHours(h,m,s,0);
          const route = routeMap[row.route_id] || {};
          return {
            tripId: row.trip_id, routeId: row.route_id,
            routeName: route.route_short_name || route.route_long_name || row.route_id,
            routeColor: route.route_color ? `#${route.route_color}` : '#123573',
            routeType: 'bus', stopId: row.stop_id,
            stopName: '', direction: row.trip_headsign || '',
            departureTime: Math.floor(dep.getTime() / 1000),
            delay: null, isRealtime: false,
          };
        });
        // Deduplicate: one departure per route+time
        const seen = new Set();
        return deps.filter(d => {
          const key = `${d.routeId}-${d.departureTime}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
    } catch {}
  }

  return [];
}

export default async function departureRoutes(fastify, { pg }) {

  // Departures at a specific stop
  fastify.get("/api/v1/departures/:system/:stop", async (req, reply) => {
    const { system, stop } = req.params;
    const limit = parseInt(req.query.limit || "20");
    const routeFilter = req.query.route || null;

    if (!SYSTEMS[system]) {
      return reply.code(404).send({
        error: "SYSTEM_NOT_FOUND",
        message: `System "${system}" is not supported. Available: ${Object.keys(SYSTEMS).join(", ")}`,
      });
    }

    let departures = await findDepartures(system, stop, pg);

    if (!departures || departures.length === 0) {
      return reply.code(404).send({
        error: "NO_DEPARTURES",
        message: `No departures found for stop "${stop}" on ${SYSTEMS[system].name}`,
        hint: "Use GET /api/v1/departures/:system to list available stops",
      });
    }

    // Filter by route if specified
    if (routeFilter) {
      const rf = routeFilter.toUpperCase();
      departures = departures.filter((d) =>
        d.routeId?.toUpperCase() === rf ||
        d.routeName?.toUpperCase() === rf
      );
    }

    // Deduplicate by tripId (child stops may have overlapping data)
    const seen = new Set();
    departures = departures.filter((d) => {
      const key = d.tripId || `${d.routeId}-${d.departureTime}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by departure time and limit
    const now = Math.floor(Date.now() / 1000);
    departures = departures
      .map((d) => ({
        ...d,
        secondsAway: d.departureTime ? d.departureTime - now : null,
        minutesAway: d.departureTime ? Math.max(0, Math.round((d.departureTime - now) / 60)) : null,
      }))
      .filter((d) => d.secondsAway === null || d.secondsAway > -60)
      .sort((a, b) => (a.departureTime || Infinity) - (b.departureTime || Infinity))
      .slice(0, limit);

    return {
      system: SYSTEMS[system],
      stop,
      departures,
      count: departures.length,
      timestamp: new Date().toISOString(),
    };
  });

  // List available stops with departures
  fastify.get("/api/v1/departures/:system", async (req, reply) => {
    const { system } = req.params;

    if (!SYSTEMS[system]) {
      return reply.code(404).send({ error: "SYSTEM_NOT_FOUND" });
    }

    const keys = await getKeys(`departures:${system}:*`);
    const stops = keys
      .map((k) => k.replace(`departures:${system}:`, ""))
      .filter((s) => !s.startsWith("_"))
      .sort();

    return {
      system: SYSTEMS[system],
      stops,
      count: stops.length,
      timestamp: new Date().toISOString(),
    };
  });

  // ─── WebSocket: live departure countdown ─────────────────────────────
  fastify.get("/ws/departures/:system/:stop", { websocket: true }, (socket, req) => {
    const { system, stop } = req.params;

    if (!SYSTEMS[system]) {
      socket.send(JSON.stringify({ type: "error", message: "System not supported" }));
      socket.close();
      return;
    }

    const clientId = Math.random().toString(36).slice(2, 8);
    let routeFilter = null;
    let interval = null;

    fastify.log.info({ clientId, system, stop }, "WS departures client connected");

    const sendUpdate = async () => {
      try {
        let departures = await findDepartures(system, stop, pg);
        if (!departures) departures = [];

        if (routeFilter) {
          const rf = routeFilter.toUpperCase();
          departures = departures.filter((d) =>
            d.routeId?.toUpperCase() === rf || d.routeName?.toUpperCase() === rf
          );
        }

        // Deduplicate
        const seen = new Set();
        departures = departures.filter((d) => {
          const key = d.tripId || `${d.routeId}-${d.departureTime}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const now = Math.floor(Date.now() / 1000);
        departures = departures
          .map((d) => ({
            ...d,
            secondsAway: d.departureTime ? d.departureTime - now : null,
            minutesAway: d.departureTime ? Math.max(0, Math.round((d.departureTime - now) / 60)) : null,
          }))
          .filter((d) => d.secondsAway === null || d.secondsAway > -60)
          .sort((a, b) => (a.departureTime || Infinity) - (b.departureTime || Infinity))
          .slice(0, 15);

        socket.send(JSON.stringify({
          type: "departures",
          system,
          stop,
          departures,
          count: departures.length,
          timestamp: Date.now(),
        }));
      } catch {}
    };

    sendUpdate();
    interval = setInterval(sendUpdate, 5000);

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.route !== undefined) { routeFilter = msg.route || null; sendUpdate(); }
        if (msg.type === "ping") socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      } catch {}
    });

    socket.on("close", () => { clearInterval(interval); });
    socket.on("error", () => clearInterval(interval));
  });
}
