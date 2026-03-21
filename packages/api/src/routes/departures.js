// packages/api/src/routes/departures.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/departures/:system/:stop          — next departures at a stop
// GET /api/v1/departures/:system                — all departure keys (debug)
// WS  /ws/departures/:system/:stop              — live countdown stream
// ─────────────────────────────────────────────────────────────────────────────

import { getJSON, getKeys, getMultiJSON } from "../redis.js";
import { SYSTEMS } from "../config.js";

export default async function departureRoutes(fastify) {

  // Departures at a specific stop
  fastify.get("/api/v1/departures/:system/:stop", async (req, reply) => {
    const { system, stop } = req.params;
    const limit = parseInt(req.query.limit || "10");
    const routeFilter = req.query.route || null;

    if (!SYSTEMS[system]) {
      return reply.code(404).send({
        error: "SYSTEM_NOT_FOUND",
        message: `System "${system}" is not supported. Available: ${Object.keys(SYSTEMS).join(", ")}`,
      });
    }

    // Try exact stop_id match first
    let departures = await getJSON(`departures:${system}:${stop}`);

    // Try station-name key (SEPTA uses this format)
    if (!departures) {
      departures = await getJSON(`departures:${system}:station:${stop}`);
    }

    // Try fuzzy search across keys if exact match fails
    if (!departures) {
      const keys = await getKeys(`departures:${system}:*${stop}*`);
      if (keys.length > 0) {
        const allDeps = await getMultiJSON(keys);
        departures = allDeps.flat();
      }
    }

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

    // Sort by departure time and limit
    const now = Math.floor(Date.now() / 1000);
    departures = departures
      .map((d) => ({
        ...d,
        secondsAway: d.departureTime ? d.departureTime - now : null,
        minutesAway: d.departureTime ? Math.max(0, Math.round((d.departureTime - now) / 60)) : null,
      }))
      .filter((d) => d.secondsAway === null || d.secondsAway > -60) // exclude trains that left >1 min ago
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

  // List available stops with departures (for discovery)
  fastify.get("/api/v1/departures/:system", async (req, reply) => {
    const { system } = req.params;

    if (!SYSTEMS[system]) {
      return reply.code(404).send({
        error: "SYSTEM_NOT_FOUND",
        message: `System "${system}" is not supported.`,
      });
    }

    const keys = await getKeys(`departures:${system}:*`);
    const stops = keys
      .map((k) => k.replace(`departures:${system}:`, ""))
      .filter((s) => !s.startsWith("_")) // exclude _summary keys
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

    // Send departures immediately and then every 5 seconds
    const sendUpdate = async () => {
      try {
        let departures = await getJSON(`departures:${system}:${stop}`);
        if (!departures) departures = await getJSON(`departures:${system}:station:${stop}`);
        if (!departures) departures = [];

        if (routeFilter) {
          const rf = routeFilter.toUpperCase();
          departures = departures.filter((d) =>
            d.routeId?.toUpperCase() === rf || d.routeName?.toUpperCase() === rf
          );
        }

        const now = Math.floor(Date.now() / 1000);
        departures = departures
          .map((d) => ({
            ...d,
            secondsAway: d.departureTime ? d.departureTime - now : null,
            minutesAway: d.departureTime ? Math.max(0, Math.round((d.departureTime - now) / 60)) : null,
          }))
          .filter((d) => d.secondsAway === null || d.secondsAway > -60)
          .sort((a, b) => (a.departureTime || Infinity) - (b.departureTime || Infinity))
          .slice(0, 10);

        socket.send(JSON.stringify({
          type: "departures",
          system: system,
          stop: stop,
          departures,
          count: departures.length,
          timestamp: Date.now(),
        }));
      } catch (err) {
        // Client may have disconnected
      }
    };

    sendUpdate();
    interval = setInterval(sendUpdate, 5000);

    // Handle client messages (route filter)
    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.route !== undefined) {
          routeFilter = msg.route || null;
          sendUpdate(); // refresh with new filter
        }
        if (msg.type === "ping") {
          socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        }
      } catch {}
    });

    socket.on("close", () => {
      clearInterval(interval);
      fastify.log.info({ clientId }, "WS departures client disconnected");
    });

    socket.on("error", () => clearInterval(interval));
  });
}
