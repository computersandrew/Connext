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

  // Single vehicle by trip ID — searches across all route keys
  app.get("/api/v1/vehicles/:system/trip/:tripId", async (req, reply) => {
    const { system, tripId } = req.params;
    if (!SYSTEMS[system]) return reply.code(404).send({ error: "Unknown system" });

    const vehicles = await getAllVehicles(system);
    const match = vehicles.find(
      (v) => String(v.tripId) === String(tripId) || String(v.vehicleId) === String(tripId)
    );

    if (!match) return reply.code(404).send({ error: "Vehicle not found", tripId });
    return reply.send({ system, vehicle: match, timestamp: new Date().toISOString() });
  });
}
