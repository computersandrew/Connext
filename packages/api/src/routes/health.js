// packages/api/src/routes/health.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/health          — overall system health
// GET /api/v1/health/:system  — health for a specific system
// GET /api/v1/systems         — list supported systems
// ─────────────────────────────────────────────────────────────────────────────

import { getJSON, getKeys, getRedis } from "../redis.js";
import { SYSTEMS } from "../config.js";

export default async function healthRoutes(fastify) {

  // Overall system health
  fastify.get("/api/v1/health", async (req, reply) => {
    const systemHealth = {};
    let totalKeys = 0;
    let healthySystems = 0;

    for (const sysId of Object.keys(SYSTEMS)) {
      const keys = await getKeys(`*${sysId}*`);
      const alertData = await getJSON(`alerts:${sysId}`);
      const keyCount = keys.length;
      totalKeys += keyCount;

      const hasData = keyCount > 0;
      if (hasData) healthySystems++;

      systemHealth[sysId] = {
        ...SYSTEMS[sysId],
        status: hasData ? "healthy" : "no_data",
        keyCount,
        alertCount: alertData?.length || 0,
      };
    }

    // Check Redis connectivity
    let redisStatus = "unknown";
    try {
      await getRedis().ping();
      redisStatus = "connected";
    } catch {
      redisStatus = "disconnected";
    }

    return {
      status: healthySystems > 0 ? "operational" : "degraded",
      redis: redisStatus,
      totalKeys,
      healthySystems,
      totalSystems: Object.keys(SYSTEMS).length,
      systems: systemHealth,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });

  // Health for a specific system
  fastify.get("/api/v1/health/:system", async (req, reply) => {
    const { system } = req.params;

    if (!SYSTEMS[system]) {
      return reply.code(404).send({
        error: "SYSTEM_NOT_FOUND",
        message: `System "${system}" is not supported. Available: ${Object.keys(SYSTEMS).join(", ")}`,
      });
    }

    const keys = await getKeys(`*${system}*`);
    const alertData = await getJSON(`alerts:${system}`);

    // Categorize keys
    const departureKeys = keys.filter((k) => k.startsWith(`departures:${system}`));
    const vehicleKeys = keys.filter((k) => k.startsWith(`vehicles:${system}`));

    return {
      ...SYSTEMS[system],
      status: keys.length > 0 ? "healthy" : "no_data",
      keyCount: keys.length,
      departures: departureKeys.length,
      vehicles: vehicleKeys.length,
      alerts: alertData?.length || 0,
      timestamp: new Date().toISOString(),
    };
  });

  // List all supported systems
  fastify.get("/api/v1/systems", async (req, reply) => {
    const systems = [];

    for (const [id, sys] of Object.entries(SYSTEMS)) {
      const keys = await getKeys(`*${id}*`);
      systems.push({
        ...sys,
        status: keys.length > 0 ? "active" : "inactive",
        keyCount: keys.length,
      });
    }

    return { systems, timestamp: new Date().toISOString() };
  });
}
