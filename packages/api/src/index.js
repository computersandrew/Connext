// packages/api/src/index.js
// ─────────────────────────────────────────────────────────────────────────────
// CONNEXT API SERVER
//
// REST + WebSocket API serving cached transit data from Redis.
// Reads data written by the ingestion engine.
//
// REST endpoints:
//   GET /api/v1/health            — system health
//   GET /api/v1/health/:system    — per-system health
//   GET /api/v1/systems           — list supported systems
//   GET /api/v1/alerts            — all alerts
//   GET /api/v1/alerts/:system    — alerts for a system
//   GET /api/v1/alerts/:sys/:route — alerts for a route
//
// WebSocket:
//   WS /ws/alerts                 — live alert stream
// ─────────────────────────────────────────────────────────────────────────────

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

import { PORT, HOST } from "./config.js";
import { getRedis } from "./redis.js";

// Routes
import alertRoutes from "./routes/alerts.js";
import healthRoutes from "./routes/health.js";

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
    origin: process.env.CORS_ORIGIN || true,  // restrict in production
    methods: ["GET"],
  });

  await app.register(rateLimit, {
    max: 120,           // requests per window
    timeWindow: 60_000, // 1 minute
    keyGenerator: (req) => {
      // Rate limit by device token header, fall back to IP
      return req.headers["x-device-token"] || req.ip;
    },
  });

  await app.register(websocket);

  // ─── Routes ──────────────────────────────────────────────────────────
  await app.register(alertRoutes);
  await app.register(healthRoutes);
  await app.register(alertsWs);

  // ─── Root endpoint ───────────────────────────────────────────────────
  app.get("/", async () => ({
    name: "Connext API",
    version: "1.0.0",
    docs: {
      health: "/api/v1/health",
      systems: "/api/v1/systems",
      alerts: "/api/v1/alerts",
      alertsBySystem: "/api/v1/alerts/:system",
      wsAlerts: "ws://HOST/ws/alerts",
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
    app.log.error({ err }, "Redis connection failed — API will start but data may be unavailable");
  }

  // ─── Start ───────────────────────────────────────────────────────────
  await app.listen({ port: PORT, host: HOST });

  app.log.info("╔══════════════════════════════════════════════╗");
  app.log.info("║           CONNEXT API SERVER v1.0             ║");
  app.log.info("╚══════════════════════════════════════════════╝");
  app.log.info(`REST:      http://${HOST}:${PORT}/api/v1/health`);
  app.log.info(`WebSocket: ws://${HOST}:${PORT}/ws/alerts`);

  // ─── Graceful shutdown ───────────────────────────────────────────────
  const shutdown = async (signal) => {
    app.log.info(`${signal} received — shutting down...`);
    await app.close();
    getRedis().disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((err) => {
  console.error("Fatal error starting API server:", err);
  process.exit(1);
});
