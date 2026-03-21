// packages/api/src/redis.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared Redis client for the API layer.
// Reads from the same keys that the ingestion engine writes.
// ─────────────────────────────────────────────────────────────────────────────

import Redis from "ioredis";
import { REDIS_CONFIG } from "./config.js";

let redis = null;

export function getRedis() {
  if (!redis) {
    redis = new Redis({
      host: REDIS_CONFIG.host,
      port: REDIS_CONFIG.port,
      password: REDIS_CONFIG.password,
      keyPrefix: REDIS_CONFIG.keyPrefix,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      maxRetriesPerRequest: 3,
    });
  }
  return redis;
}

/**
 * Get parsed JSON from a Redis key
 * @returns {object|null}
 */
export async function getJSON(key) {
  const raw = await getRedis().get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Get all keys matching a pattern (without the prefix)
 */
export async function getKeys(pattern) {
  const fullPattern = REDIS_CONFIG.keyPrefix + pattern;
  const keys = await getRedis().keys(fullPattern);
  // Strip the prefix back off
  return keys.map((k) => k.slice(REDIS_CONFIG.keyPrefix.length));
}

/**
 * Get multiple JSON values by keys
 */
export async function getMultiJSON(keys) {
  if (keys.length === 0) return [];
  const pipeline = getRedis().pipeline();
  for (const key of keys) pipeline.get(key);
  const results = await pipeline.exec();
  return results.map(([err, raw]) => {
    if (err || !raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }).filter(Boolean);
}
