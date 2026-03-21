// packages/api/src/routes/planner.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/plan/:system?from=X&to=Y  — find routes with transfer probability
//
// Returns multiple route options sorted by fastest, each with:
//   - Legs (walk, ride, transfer)
//   - Transfer details (type, platform info, accessibility)
//   - Connection probability per transfer and overall
//   - "Leave by" time
// ─────────────────────────────────────────────────────────────────────────────

import { getJSON, getKeys } from "../redis.js";
import { SYSTEMS } from "../config.js";
import { TransferEngine, TransferType } from "../../src-shared/TransferEngine.js";

// Transfer engines per system — loaded once on startup
const engines = new Map();

/**
 * Initialize transfer engines for all systems.
 * Called once when the route is registered.
 */
async function initEngines(pg, logger) {
  const { TRANSFER_OVERRIDES } = await import("../../src-shared/transfer-overrides.js");

  for (const sysId of Object.keys(SYSTEMS)) {
    const engine = new TransferEngine(logger);

    // Load from GTFS transfers.txt if available
    if (pg) {
      await engine.loadFromGtfs(pg, sysId);
    }

    // Load manual overrides
    if (TRANSFER_OVERRIDES[sysId]) {
      engine.loadManualOverrides(TRANSFER_OVERRIDES[sysId]);
    }

    engines.set(sysId, engine);
    logger.info(`Transfer engine loaded for ${sysId}: ${JSON.stringify(engine.getStats())}`);
  }
}

export default async function plannerRoutes(fastify, { pg }) {
  // Initialize transfer engines
  await initEngines(pg, fastify.log);

  // ─── Route planner endpoint ──────────────────────────────────────────
  fastify.get("/api/v1/plan/:system", async (req, reply) => {
    const { system } = req.params;
    const { from, to, depart, pace } = req.query;

    if (!SYSTEMS[system]) {
      return reply.code(404).send({
        error: "SYSTEM_NOT_FOUND",
        message: `System "${system}" is not supported.`,
      });
    }

    if (!from || !to) {
      return reply.code(400).send({
        error: "MISSING_PARAMS",
        message: "Both 'from' and 'to' query parameters are required.",
        example: `/api/v1/plan/${system}?from=STOP_ID&to=STOP_ID`,
      });
    }

    const engine = engines.get(system);
    const now = Math.floor(Date.now() / 1000);
    const departTime = depart ? parseTimeToUnix(depart) : now;
    const walkingPace = pace || "average";
    const hour = new Date(departTime * 1000).getHours();
    const rushHour = (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19);

    // Get available departures from origin
    const fromDepartures = await findDepartures(system, from);
    const toDepartures = await findDepartures(system, to);

    if (fromDepartures.length === 0) {
      return reply.code(404).send({
        error: "NO_DEPARTURES_FROM",
        message: `No departures found from "${from}"`,
      });
    }

    // Generate route options
    const routes = generateRoutes(
      system, from, to, fromDepartures, toDepartures,
      engine, departTime, walkingPace, rushHour
    );

    // Sort by total time
    routes.sort((a, b) => a.totalTimeSec - b.totalTimeSec);

    return {
      system: SYSTEMS[system],
      from,
      to,
      departAt: new Date(departTime * 1000).toISOString(),
      rushHour,
      walkingPace,
      routes: routes.slice(0, 5), // top 5 options
      count: Math.min(routes.length, 5),
      timestamp: new Date().toISOString(),
    };
  });

  // ─── Transfer info endpoint ──────────────────────────────────────────
  fastify.get("/api/v1/transfer/:system/:fromStop/:toStop", async (req, reply) => {
    const { system, fromStop, toStop } = req.params;
    const { fromRoute, toRoute } = req.query;

    if (!SYSTEMS[system]) {
      return reply.code(404).send({ error: "SYSTEM_NOT_FOUND" });
    }

    const engine = engines.get(system);
    if (!engine) {
      return reply.code(500).send({ error: "ENGINE_NOT_LOADED" });
    }

    const transfer = engine.getTransfer(fromStop, toStop, fromRoute || null, toRoute || null);

    if (!transfer) {
      return {
        system: SYSTEMS[system],
        from: fromStop,
        to: toStop,
        transfer: null,
        message: "No transfer data available for this stop pair",
      };
    }

    // Calculate probability at various buffer times
    const probabilities = [60, 120, 180, 240, 300, 420, 600].map((buffer) => ({
      bufferSeconds: buffer,
      bufferMinutes: buffer / 60,
      probability: engine.calculateConnectionProbability(fromStop, toStop, buffer, {
        fromRouteId: fromRoute,
        toRouteId: toRoute,
      }).probability,
    }));

    return {
      system: SYSTEMS[system],
      from: fromStop,
      to: toStop,
      transfer: {
        type: transfer.type,
        fixedTimeSeconds: transfer.fixedTimeSec,
        fixedTimeMinutes: Math.round(transfer.fixedTimeSec / 60 * 10) / 10,
        distribution: transfer.distribution,
        accessibility: transfer.accessibility,
        notes: transfer.notes,
        source: transfer.source,
      },
      probabilities,
      timestamp: new Date().toISOString(),
    };
  });

  // ─── Transfer engine stats ───────────────────────────────────────────
  fastify.get("/api/v1/transfers/:system/stats", async (req, reply) => {
    const { system } = req.params;
    const engine = engines.get(system);
    if (!engine) return reply.code(404).send({ error: "No engine for system" });
    return { system, stats: engine.getStats() };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTE GENERATION
// ═══════════════════════════════════════════════════════════════════════════

function generateRoutes(system, from, to, fromDeps, toDeps, engine, departTime, walkingPace, rushHour) {
  const routes = [];
  const now = departTime;

  // Group departures by route
  const fromByRoute = groupBy(fromDeps, "routeId");
  const toByRoute = groupBy(toDeps, "routeId");

  // ─── Direct routes (same line, no transfer) ──────────────────────────
  for (const [routeId, deps] of Object.entries(fromByRoute)) {
    if (toByRoute[routeId]) {
      // Same route serves both stops — direct route
      const nextDep = deps.find((d) => d.departureTime && d.departureTime >= now);
      if (!nextDep) continue;

      const toArrival = toByRoute[routeId].find((d) => d.departureTime && d.departureTime > nextDep.departureTime);
      const rideSec = toArrival ? toArrival.departureTime - nextDep.departureTime : estimateRideTime(from, to);

      routes.push({
        id: `direct-${routeId}-${nextDep.departureTime}`,
        type: "direct",
        totalTimeSec: rideSec + (nextDep.departureTime - now),
        totalTimeMin: Math.round((rideSec + (nextDep.departureTime - now)) / 60),
        transfers: 0,
        overallProbability: null, // no transfer = guaranteed
        leaveBy: new Date(nextDep.departureTime * 1000 - walkTimeSec(walkingPace) * 1000).toISOString(),
        legs: [
          {
            type: "walk",
            durationSec: walkTimeSec(walkingPace),
            durationMin: Math.round(walkTimeSec(walkingPace) / 60),
            description: `Walk to ${from}`,
          },
          {
            type: "ride",
            routeId,
            routeName: nextDep.routeName || routeId,
            routeColor: nextDep.routeColor || "#888",
            from: from,
            to: to,
            departureTime: new Date(nextDep.departureTime * 1000).toISOString(),
            durationSec: rideSec,
            durationMin: Math.round(rideSec / 60),
            direction: nextDep.direction || "",
            delay: nextDep.delay || null,
            isRealtime: nextDep.isRealtime || false,
          },
        ],
      });
    }
  }

  // ─── One-transfer routes ─────────────────────────────────────────────
  // Find routes where Line A from origin connects to Line B at a transfer station to destination
  for (const [fromRoute, fromRouteDeps] of Object.entries(fromByRoute)) {
    for (const [toRoute, toRouteDeps] of Object.entries(toByRoute)) {
      if (fromRoute === toRoute) continue; // already handled as direct

      // Find possible transfer stations (stops served by both routes in the data)
      const transferStops = findTransferStops(system, fromRoute, toRoute);

      for (const transferStop of transferStops) {
        const nextFromDep = fromRouteDeps.find((d) => d.departureTime && d.departureTime >= now);
        if (!nextFromDep) continue;

        // Estimate arrival at transfer stop
        const rideToTransferSec = estimateRideTime(from, transferStop);
        const arriveAtTransfer = nextFromDep.departureTime + rideToTransferSec;

        // Get transfer details from engine
        const transferInfo = engine.calculateConnectionProbability(
          transferStop, transferStop, // same station, different platform
          0, // we'll calculate actual buffer below
          { fromRouteId: fromRoute, toRouteId: toRoute, rushHour, walkingPace }
        );

        const transferTimeSec = transferInfo.transferTime;

        // Find next departure on the connecting line after transfer
        const readyTime = arriveAtTransfer + transferTimeSec;
        const nextToDep = toRouteDeps.find((d) => d.departureTime && d.departureTime >= readyTime);

        if (!nextToDep) continue;

        // Actual buffer = time between arrival at transfer and next connecting departure
        const actualBuffer = nextToDep.departureTime - arriveAtTransfer;

        // Recalculate probability with actual buffer
        const connectionProb = engine.calculateConnectionProbability(
          transferStop, transferStop,
          actualBuffer,
          { fromRouteId: fromRoute, toRouteId: toRoute, rushHour, walkingPace }
        );

        // Ride from transfer to destination
        const rideFromTransferSec = estimateRideTime(transferStop, to);
        const totalSec = (nextFromDep.departureTime - now) + rideToTransferSec + actualBuffer + rideFromTransferSec;

        routes.push({
          id: `transfer-${fromRoute}-${toRoute}-${transferStop}-${nextFromDep.departureTime}`,
          type: "one_transfer",
          totalTimeSec: totalSec,
          totalTimeMin: Math.round(totalSec / 60),
          transfers: 1,
          overallProbability: connectionProb.probability,
          leaveBy: new Date(nextFromDep.departureTime * 1000 - walkTimeSec(walkingPace) * 1000).toISOString(),
          legs: [
            {
              type: "walk",
              durationSec: walkTimeSec(walkingPace),
              durationMin: Math.round(walkTimeSec(walkingPace) / 60),
              description: `Walk to ${from}`,
            },
            {
              type: "ride",
              routeId: fromRoute,
              routeName: nextFromDep.routeName || fromRoute,
              routeColor: nextFromDep.routeColor || "#888",
              from: from,
              to: transferStop,
              departureTime: new Date(nextFromDep.departureTime * 1000).toISOString(),
              durationSec: rideToTransferSec,
              durationMin: Math.round(rideToTransferSec / 60),
              direction: nextFromDep.direction || "",
              delay: nextFromDep.delay || null,
              isRealtime: nextFromDep.isRealtime || false,
            },
            {
              type: "transfer",
              station: transferStop,
              transferType: connectionProb.type,
              transferTimeSec: connectionProb.transferTime,
              transferTimeMin: Math.round(connectionProb.transferTime / 60 * 10) / 10,
              bufferSec: actualBuffer,
              bufferMin: Math.round(actualBuffer / 60 * 10) / 10,
              probability: connectionProb.probability,
              probabilityPct: Math.round(connectionProb.probability * 100),
              accessibility: connectionProb.accessibility || null,
              notes: connectionProb.notes || null,
              platformChange: connectionProb.type !== TransferType.SAME_PLATFORM,
            },
            {
              type: "ride",
              routeId: toRoute,
              routeName: nextToDep.routeName || toRoute,
              routeColor: nextToDep.routeColor || "#888",
              from: transferStop,
              to: to,
              departureTime: new Date(nextToDep.departureTime * 1000).toISOString(),
              durationSec: rideFromTransferSec,
              durationMin: Math.round(rideFromTransferSec / 60),
              direction: nextToDep.direction || "",
              delay: nextToDep.delay || null,
              isRealtime: nextToDep.isRealtime || false,
            },
          ],
        });
      }
    }
  }

  return routes;
}

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function findDepartures(system, stopId) {
  let deps = await getJSON(`departures:${system}:${stopId}`);
  if (!deps) deps = await getJSON(`departures:${system}:station:${stopId}`);
  if (!deps) {
    // Fuzzy: search for keys containing the stop ID
    const keys = await getKeys(`departures:${system}:*${stopId}*`);
    if (keys.length > 0) {
      const allDeps = await getMultiJSON(keys);
      deps = allDeps.flat();
    }
  }
  return deps || [];
}

function findTransferStops(system, fromRoute, toRoute) {
  // In production, this queries the GTFS data for stops served by both routes.
  // For now, return common known transfer stations per system.
  const commonTransfers = {
    mta: ["127", "631", "635", "A40", "229", "R20", "D17", "A27", "725"],
    mbta: ["place-pktrm", "place-dwnxg", "place-state", "place-gover", "place-sstat"],
    septa: ["BSL_city_hall", "MFL_city_hall", "MFL_30th", "MFL_jefferson", "MFL_69th"],
    cta: ["40380", "40660", "41400", "41220"],
  };
  return commonTransfers[system] || [];
}

function estimateRideTime(from, to) {
  // Rough estimate: 2-3 minutes per stop, average 5 stops
  // In production, this uses actual GTFS stop_times data
  return 300 + Math.floor(Math.random() * 600); // 5-15 min
}

function walkTimeSec(pace) {
  const times = { slow: 360, average: 240, fast: 150 };
  return times[pace] || 240;
}

function parseTimeToUnix(timeStr) {
  if (!timeStr) return Math.floor(Date.now() / 1000);
  const now = new Date();
  const match = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (match) {
    now.setHours(parseInt(match[1]), parseInt(match[2]), 0, 0);
    return Math.floor(now.getTime() / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function groupBy(arr, key) {
  const result = {};
  for (const item of arr) {
    const k = item[key] || "unknown";
    if (!result[k]) result[k] = [];
    result[k].push(item);
  }
  return result;
}
