// packages/api/src/routes/vehicles.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/vehicles/:system              — all vehicles for a system
// GET /api/v1/vehicles/:system/trip/:tripId — single vehicle by trip ID
// ─────────────────────────────────────────────────────────────────────────────

import { getKeys, getMultiJSON } from "../redis.js";
import { SYSTEMS } from "../config.js";

// Fetch all vehicle records for a system by scanning route-keyed Redis entries
async function getAllVehicles(system) {
  const keys = await getKeys(`vehicles:${system}:*`);
  if (!keys || keys.length === 0) return [];
  const results = await getMultiJSON(keys);
  return results.flat().filter(Boolean);
}

// SEPTA GTFS-RT trip IDs are formatted as "{ROUTE_CODE}{TRAIN_NUM}_{DATE}_SID{SID}"
// e.g. "NOR2325_20260330_SID185189" → train number "2325"
// Extract the numeric train number so we can match against TrainView vehicleId.
function extractTrainNumber(tripId) {
  const m = String(tripId || "").match(/^[A-Z]+(\d+)_/);
  return m ? m[1] : null;
}

export default async function vehicleRoutes(app) {
  // All vehicles for a system
  app.get("/api/v1/vehicles/:system", async (req, reply) => {
    const { system } = req.params;
    if (!SYSTEMS[system]) return reply.code(404).send({ error: "Unknown system" });

    const vehicles = await getAllVehicles(system);
    return reply.send({
      system,
      count: vehicles.length,
      vehicles,
      timestamp: new Date().toISOString(),
    });
  });

  // Single vehicle by trip ID — searches across all route keys.
  // Falls back to extracting the numeric train number from SEPTA-style GTFS trip IDs.
  app.get("/api/v1/vehicles/:system/trip/:tripId", async (req, reply) => {
    const { system, tripId } = req.params;
    if (!SYSTEMS[system]) return reply.code(404).send({ error: "Unknown system" });

    const vehicles = await getAllVehicles(system);
    const tid = String(tripId);
    const trainNum = extractTrainNumber(tid); // e.g. "2325" from "NOR2325_20260330_SID185189"

    const match = vehicles.find((v) =>
      String(v.tripId) === tid ||
      String(v.vehicleId) === tid ||
      (trainNum && (String(v.tripId) === trainNum || String(v.vehicleId) === trainNum))
    );

    if (!match) return reply.code(404).send({ error: "Vehicle not found", tripId });
    return reply.send({ system, vehicle: match, timestamp: new Date().toISOString() });
  });
}
