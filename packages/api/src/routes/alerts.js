// packages/api/src/routes/alerts.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/alerts              — all alerts across all systems
// GET /api/v1/alerts/:system      — alerts for a specific system
// GET /api/v1/alerts/:system/:route — alerts for a specific route
// ─────────────────────────────────────────────────────────────────────────────

import { getJSON } from "../redis.js";
import { SYSTEMS } from "../config.js";

export default async function alertRoutes(fastify) {

  // All alerts across all systems
  fastify.get("/api/v1/alerts", async (req, reply) => {
    const allAlerts = {};
    let totalCount = 0;

    for (const sysId of Object.keys(SYSTEMS)) {
      const alerts = await getJSON(`alerts:${sysId}`);
      if (alerts && alerts.length > 0) {
        allAlerts[sysId] = {
          system: SYSTEMS[sysId],
          alerts,
          count: alerts.length,
        };
        totalCount += alerts.length;
      }
    }

    return {
      totalAlerts: totalCount,
      systems: allAlerts,
      timestamp: new Date().toISOString(),
    };
  });

  // Alerts for a specific system
  fastify.get("/api/v1/alerts/:system", async (req, reply) => {
    const { system } = req.params;

    if (!SYSTEMS[system]) {
      return reply.code(404).send({
        error: "SYSTEM_NOT_FOUND",
        message: `System "${system}" is not supported. Available: ${Object.keys(SYSTEMS).join(", ")}`,
      });
    }

    const alerts = await getJSON(`alerts:${system}`) || [];

    return {
      system: SYSTEMS[system],
      alerts,
      count: alerts.length,
      timestamp: new Date().toISOString(),
    };
  });

  // Alerts filtered by route within a system
  fastify.get("/api/v1/alerts/:system/:route", async (req, reply) => {
    const { system, route } = req.params;

    if (!SYSTEMS[system]) {
      return reply.code(404).send({
        error: "SYSTEM_NOT_FOUND",
        message: `System "${system}" is not supported.`,
      });
    }

    const allAlerts = await getJSON(`alerts:${system}`) || [];
    const routeUpper = route.toUpperCase();

    const filtered = allAlerts.filter((alert) =>
      alert.routeIds?.some((r) => r.toUpperCase() === routeUpper) ||
      alert.routeNames?.some((r) => r.toUpperCase() === routeUpper)
    );

    return {
      system: SYSTEMS[system],
      route,
      alerts: filtered,
      count: filtered.length,
      timestamp: new Date().toISOString(),
    };
  });
}
