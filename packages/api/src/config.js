// packages/api/src/config.js
// ─────────────────────────────────────────────────────────────────────────────

export const PORT = parseInt(process.env.API_PORT || "3000");
export const HOST = process.env.API_HOST || "0.0.0.0";

export const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
  keyPrefix: "connext:",
};

export const SYSTEMS = {
  mta:   { id: "mta",   name: "MTA",   city: "New York City" },
  mbta:  { id: "mbta",  name: "MBTA",  city: "Boston" },
  cta:   { id: "cta",   name: "CTA",   city: "Chicago" },
  septa: { id: "septa", name: "SEPTA", city: "Philadelphia" },
};

export const WS_CONFIG = {
  alertBroadcastIntervalMs: 10_000,   // push alert updates every 10s
  heartbeatIntervalMs: 30_000,        // keep-alive ping every 30s
};
