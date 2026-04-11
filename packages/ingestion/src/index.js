// connext-ingestion/src/index.js
// ─────────────────────────────────────────────────────────────────────────────
// CONNEXT INGESTION ENGINE
//
// Starts the modular GTFS-RT feed ingestion system.
// Loads all adapter plugins, connects to Redis/PostgreSQL, and begins polling.
//
// Usage:
//   npm start                     # start all enabled systems
//   LOG_LEVEL=debug npm start     # verbose logging
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { createRequire } from "module";
import pino from "pino";
import Redis from "ioredis";
import pg from "pg";

import { SYSTEMS, REDIS_CONFIG, PG_CONFIG, INGESTION_CONFIG } from "../config/systems.js";
import { Orchestrator } from "./core/Orchestrator.js";
import { FeedFetcher } from "./core/FeedFetcher.js";

// ─── Logger ──────────────────────────────────────────────────────────────────
const logger = pino({
  level: INGESTION_CONFIG.logLevel,
  transport: process.env.NODE_ENV !== "production"
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
    : undefined,
});

// ─── Banner ──────────────────────────────────────────────────────────────────
logger.info("╔══════════════════════════════════════════════╗");
logger.info("║         CONNEXT INGESTION ENGINE v1.0        ║");
logger.info("╚══════════════════════════════════════════════╝");

// ─── Connect to services ─────────────────────────────────────────────────────
async function connectRedis() {
  const redis = new Redis({
    host: REDIS_CONFIG.host,
    port: REDIS_CONFIG.port,
    password: REDIS_CONFIG.password,
    keyPrefix: REDIS_CONFIG.keyPrefix,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    maxRetriesPerRequest: 3,
  });

  redis.on("error", (err) => logger.error({ err }, "Redis error"));
  redis.on("connect", () => logger.info(`Redis connected: ${REDIS_CONFIG.host}:${REDIS_CONFIG.port}`));
  return redis;
}

async function connectPg() {
  const pool = new pg.Pool({
    host: PG_CONFIG.host,
    port: PG_CONFIG.port,
    database: PG_CONFIG.database,
    user: PG_CONFIG.user,
    password: PG_CONFIG.password,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  pool.on("error", (err) => logger.error({ err }, "PostgreSQL pool error"));

  // Test connection
  try {
    const client = await pool.connect();
    client.release();
    logger.info(`PostgreSQL connected: ${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database}`);
  } catch (err) {
    logger.warn({ err }, "PostgreSQL not available — adapters will run without static GTFS enrichment");
  }

  return pool;
}

// ─── Health endpoint ─────────────────────────────────────────────────────────
// Lightweight HTTP server for monitoring/health checks
import { createServer } from "http";

function startHealthServer(orchestrator, port = 9090) {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      const health = orchestrator.getHealth();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health, null, 2));
    } else if (req.url === "/adapters") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(orchestrator.getRegisteredAdapters()));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    logger.info(`Health endpoint: http://localhost:${port}/health`);
  });

  return server;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const redis = await connectRedis();
  const pgPool = await connectPg();
  const fetcher = new FeedFetcher(logger);

  const deps = { redis, pg: pgPool, logger, fetcher };

  // Create orchestrator and discover adapters
  const orchestrator = new Orchestrator(SYSTEMS, deps);
  await orchestrator.loadAdapters();

  // List what we found
  const registered = orchestrator.getRegisteredAdapters();
  const enabled = Object.values(SYSTEMS).filter((s) => s.enabled);
  logger.info(`Registered adapters: [${registered.join(", ")}]`);
  logger.info(`Enabled systems: [${enabled.map((s) => s.id).join(", ")}]`);

  // Check for unmatched systems
  for (const sys of enabled) {
    if (!registered.includes(sys.adapter)) {
      logger.warn(`⚠ System "${sys.id}" uses adapter "${sys.adapter}" which was not found`);
    }
  }

  // Start all enabled systems
  await orchestrator.startAll();

  // Start health endpoint
  const healthServer = startHealthServer(orchestrator);

  // ─── Graceful shutdown ─────────────────────────────────────────────────
  const shutdown = async (signal) => {
    logger.info(`\n${signal} received — shutting down...`);
    await orchestrator.stopAll();
    healthServer.close();
    redis.disconnect();
    await pgPool.end();
    logger.info("Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("Ingestion engine running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error starting ingestion engine");
  process.exit(1);
});
