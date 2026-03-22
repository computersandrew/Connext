// packages/api/src/index.js
// ─────────────────────────────────────────────────────────────────────────────
// CONNEXT API SERVER v1.1
//
// REST + WebSocket API serving cached transit data from Redis.
//
// REST endpoints:
//   GET /api/v1/health                          — system health
//   GET /api/v1/health/:system                  — per-system health
//   GET /api/v1/systems                         — list supported systems
//   GET /api/v1/alerts                          — all alerts
//   GET /api/v1/alerts/:system                  — alerts for a system
//   GET /api/v1/alerts/:system/:route           — alerts for a route
//   GET /api/v1/departures/:system              — list stops with data
//   GET /api/v1/departures/:system/:stop        — departures at a stop
//   GET /api/v1/plan/:system?from=X&to=Y        — route planner
//   GET /api/v1/transfer/:sys/:from/:to         — transfer detail
//   GET /api/v1/transfers/:system/stats         — transfer engine stats
//
// WebSocket:
//   WS /ws/alerts                               — live alert stream
//   WS /ws/departures/:system/:stop             — live departure countdown
// ─────────────────────────────────────────────────────────────────────────────

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import pg from "pg";

import { PORT, HOST, REDIS_CONFIG } from "./config.js";
import { getRedis } from "./redis.js";

// Routes
import alertRoutes from "./routes/alerts.js";
import healthRoutes from "./routes/health.js";
import departureRoutes from "./routes/departures.js";
import plannerRoutes from "./routes/planner.js";
import stopRoutes from "./routes/stops.js";
// WebSocket handlers
import alertsWs, { getWsClientCount } from "./ws/alerts.js";

// ─── Build server ────────────────────────────────────────────────────────────
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    transport: process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
  },
});

async function start() {
  // ─── Plugins ─────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || true,
    methods: ["GET"],
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: 60_000,
    keyGenerator: (req) => req.headers["x-device-token"] || req.ip,
  });

  await app.register(websocket);

  // ─── PostgreSQL (for transfer engine) ────────────────────────────────
  let pgPool = null;
  try {
    pgPool = new pg.Pool({
      host: process.env.PG_HOST || "127.0.0.1",
      port: parseInt(process.env.PG_PORT || "5432"),
      database: process.env.PG_DATABASE || "connext",
      user: process.env.PG_USER || "connext",
      password: process.env.PG_PASSWORD || "connext",
      max: 5,
    });
    await pgPool.query("SELECT 1");
    app.log.info("PostgreSQL connected (for transfer engine)");
  } catch (err) {
    app.log.warn({ err }, "PostgreSQL not available — transfer engine will use manual overrides only");
    pgPool = null;
  }

  // ─── Routes ──────────────────────────────────────────────────────────
  await app.register(alertRoutes);
  await app.register(healthRoutes);
  await app.register(departureRoutes, { pg: pgPool });
  await app.register(plannerRoutes, { pg: pgPool });
  await app.register(alertsWs);
  await app.register(stopRoutes, { pg: pgPool });

  // ─── Root endpoint ───────────────────────────────────────────────────
  app.get("/", async () => ({
    name: "Connext API",
    version: "1.1.0",
    endpoints: {
      health: "GET /api/v1/health",
      systems: "GET /api/v1/systems",
      alerts: "GET /api/v1/alerts",
      alertsBySystem: "GET /api/v1/alerts/:system",
      departures: "GET /api/v1/departures/:system/:stop",
      plan: "GET /api/v1/plan/:system?from=X&to=Y&pace=average",
      transfer: "GET /api/v1/transfer/:system/:fromStop/:toStop",
      wsAlerts: "WS /ws/alerts",
      wsDepartures: "WS /ws/departures/:system/:stop",
    },
    wsClients: getWsClientCount(),
    timestamp: new Date().toISOString(),
  }));

  // ─── 404 handler ─────────────────────────────────────────────────────
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: "NOT_FOUND",
      message: `Route ${req.method} ${req.url} not found`,
      docs: "/",
    });
  });

  // ─── Verify Redis connection ─────────────────────────────────────────
  try {
    await getRedis().ping();
    app.log.info("Redis connected");
  } catch (err) {
    app.log.error({ err }, "Redis connection failed");
  }

  // ─── Start ───────────────────────────────────────────────────────────
  await app.listen({ port: PORT, host: HOST });

  app.log.info("╔══════════════════════════════════════════════╗");
  app.log.info("║         CONNEXT API SERVER v1.1               ║");
  app.log.info("╚══════════════════════════════════════════════╝");
  app.log.info(`REST:      http://${HOST}:${PORT}/`);
  app.log.info(`WebSocket: ws://${HOST}:${PORT}/ws/alerts`);
  app.log.info(`WebSocket: ws://${HOST}:${PORT}/ws/departures/:system/:stop`);

  // ─── Graceful shutdown ───────────────────────────────────────────────
  const shutdown = async (signal) => {
    app.log.info(`${signal} received — shutting down...`);
    await app.close();
    getRedis().disconnect();
    if (pgPool) await pgPool.end();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((err) => {
  console.error("Fatal error starting API server:", err);
  process.exit(1);
});
