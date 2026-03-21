// packages/api/src/ws/alerts.js
// ─────────────────────────────────────────────────────────────────────────────
// WebSocket endpoint: /ws/alerts
//
// Clients connect and optionally send a filter message:
//   { "systems": ["mta", "mbta"] }   — only get alerts for these systems
//   { "systems": [] } or no message  — get all alerts
//
// Server pushes alert updates at a regular interval.
// Also pushes immediately when alert data changes.
// ─────────────────────────────────────────────────────────────────────────────

import { getJSON } from "../redis.js";
import { SYSTEMS, WS_CONFIG } from "../config.js";

// Track connected clients
const clients = new Map(); // ws -> { systems: Set, lastHash: string }
let broadcastTimer = null;

/**
 * Register the WebSocket route with Fastify
 */
export default async function alertsWs(fastify) {
  fastify.get("/ws/alerts", { websocket: true }, (socket, req) => {
    const clientId = Math.random().toString(36).slice(2, 10);
    const clientState = {
      systems: new Set(Object.keys(SYSTEMS)), // default: all systems
      lastHash: "",
    };
    clients.set(socket, clientState);

    fastify.log.info({ clientId, totalClients: clients.size }, "WS client connected");

    // Send initial alert snapshot immediately
    sendAlertSnapshot(socket, clientState);

    // Handle client messages (filter updates)
    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.systems && Array.isArray(msg.systems)) {
          // Update filter
          clientState.systems = new Set(
            msg.systems.filter((s) => SYSTEMS[s]).map((s) => s.toLowerCase())
          );
          // If empty array or no valid systems, default to all
          if (clientState.systems.size === 0) {
            clientState.systems = new Set(Object.keys(SYSTEMS));
          }
          fastify.log.debug({ clientId, systems: [...clientState.systems] }, "WS filter updated");
          // Send fresh snapshot with new filter
          sendAlertSnapshot(socket, clientState);
        }

        if (msg.type === "ping") {
          socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        }
      } catch {
        // Ignore invalid messages
      }
    });

    // Cleanup on disconnect
    socket.on("close", () => {
      clients.delete(socket);
      fastify.log.info({ clientId, totalClients: clients.size }, "WS client disconnected");
    });

    socket.on("error", () => {
      clients.delete(socket);
    });
  });

  // Start the broadcast loop
  startBroadcastLoop(fastify.log);
}

/**
 * Send current alert state to a single client
 */
async function sendAlertSnapshot(socket, clientState) {
  try {
    const payload = await buildAlertPayload(clientState.systems);
    const json = JSON.stringify(payload);
    const hash = simpleHash(json);

    // Only send if data actually changed
    if (hash !== clientState.lastHash) {
      clientState.lastHash = hash;
      socket.send(json);
    }
  } catch {
    // Client may have disconnected
  }
}

/**
 * Build the alert payload for a set of systems
 */
async function buildAlertPayload(systemFilter) {
  const alerts = {};
  let totalCount = 0;

  for (const sysId of systemFilter) {
    const data = await getJSON(`alerts:${sysId}`);
    if (data && data.length > 0) {
      alerts[sysId] = data;
      totalCount += data.length;
    }
  }

  return {
    type: "alerts",
    totalAlerts: totalCount,
    alerts,
    timestamp: Date.now(),
  };
}

/**
 * Broadcast loop — push updates to all connected clients
 */
function startBroadcastLoop(logger) {
  if (broadcastTimer) return;

  broadcastTimer = setInterval(async () => {
    if (clients.size === 0) return;

    for (const [socket, clientState] of clients) {
      try {
        await sendAlertSnapshot(socket, clientState);
      } catch {
        // Remove dead connections
        clients.delete(socket);
      }
    }
  }, WS_CONFIG.alertBroadcastIntervalMs);

  // Also set up heartbeat to keep connections alive
  setInterval(() => {
    for (const [socket] of clients) {
      try {
        socket.send(JSON.stringify({ type: "heartbeat", timestamp: Date.now() }));
      } catch {
        clients.delete(socket);
      }
    }
  }, WS_CONFIG.heartbeatIntervalMs);

  logger.info(
    `WS broadcast loop started: alerts every ${WS_CONFIG.alertBroadcastIntervalMs / 1000}s, heartbeat every ${WS_CONFIG.heartbeatIntervalMs / 1000}s`
  );
}

/**
 * Simple hash for change detection
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return String(hash);
}

/**
 * Get connected client count (for health endpoint)
 */
export function getWsClientCount() {
  return clients.size;
}
