// packages/api/src/routes/stops.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/stops/:system              — all stops with names
// GET /api/v1/stops/:system/search?q=X   — search stops by name
// ─────────────────────────────────────────────────────────────────────────────

import { SYSTEMS } from "../config.js";
import { getKeys } from "../redis.js";

export default async function stopRoutes(fastify, { pg }) {

  // Search stops by name
  fastify.get("/api/v1/stops/:system/search", async (req, reply) => {
    const { system } = req.params;
    const q = req.query.q || "";

    if (!SYSTEMS[system]) {
      return reply.code(404).send({ error: "SYSTEM_NOT_FOUND" });
    }

    if (!q || q.length < 1) {
      return reply.code(400).send({ error: "QUERY_REQUIRED", message: "Provide ?q=search_term" });
    }

    if (!pg) {
      return reply.code(503).send({ error: "DB_UNAVAILABLE" });
    }

    const result = await pg.query(
      `SELECT DISTINCT stop_id, stop_name, stop_lat, stop_lon, parent_station
       FROM gtfs_stops
       WHERE system_id = $1
         AND LOWER(stop_name) LIKE $2
         AND parent_station = ''
       ORDER BY stop_name
       LIMIT 20`,
      [system, `%${q.toLowerCase()}%`]
    );

    // If no parent-only results, try all stops
    let rows = result.rows;
    if (rows.length === 0) {
      const fallback = await pg.query(
        `SELECT DISTINCT ON (stop_name) stop_id, stop_name, stop_lat, stop_lon, parent_station
         FROM gtfs_stops
         WHERE system_id = $1
           AND LOWER(stop_name) LIKE $2
         ORDER BY stop_name, stop_id
         LIMIT 20`,
        [system, `%${q.toLowerCase()}%`]
      );
      rows = fallback.rows;
    }

    return {
      system,
      query: q,
      stops: rows.map((r) => ({
        stopId: r.stop_id,
        name: r.stop_name,
        lat: parseFloat(r.stop_lat),
        lon: parseFloat(r.stop_lon),
        parentStation: r.parent_station || null,
      })),
      count: rows.length,
    };
  });

  // List all stops (parent stations preferred)
  fastify.get("/api/v1/stops/:system", async (req, reply) => {
    const { system } = req.params;

    if (!SYSTEMS[system]) {
      return reply.code(404).send({ error: "SYSTEM_NOT_FOUND" });
    }

    if (!pg) {
      return reply.code(503).send({ error: "DB_UNAVAILABLE" });
    }

    const result = await pg.query(
      `SELECT DISTINCT ON (stop_name) stop_id, stop_name, stop_lat, stop_lon
       FROM gtfs_stops
       WHERE system_id = $1
       ORDER BY stop_name, stop_id
       LIMIT 500`,
      [system]
    );

    return {
      system,
      stops: result.rows.map((r) => ({
        stopId: r.stop_id,
        name: r.stop_name,
        lat: parseFloat(r.stop_lat),
        lon: parseFloat(r.stop_lon),
      })),
      count: result.rows.length,
    };
  });
}
