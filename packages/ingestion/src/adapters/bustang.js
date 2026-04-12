// packages/ingestion/src/adapters/bustang.js
// ─────────────────────────────────────────────────────────────────────────────
// Bustang (CDOT — Colorado Department of Transportation) Adapter
//
// Bustang is Colorado's intercity bus service connecting Denver to:
//   Fort Collins, Greeley (North routes)
//   Colorado Springs, Pueblo (South routes)
//   Glenwood Springs, Grand Junction (West routes)
//   Breckenridge, Frisco (Mountain routes — Snowstang seasonal)
//
// Uses standard GTFS-RT protobuf feeds from RTD's open data portal.
// No API key required.
// Feeds: https://open-data.rtd-denver.com/files/gtfs-rt/cdot/
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAdapter } from "../core/BaseAdapter.js";
import { RouteLookup } from "../utils/route-lookup.js";
import {
  decodeFeed, extractTripUpdates, extractVehiclePositions,
  resolveStopTime, mapVehicleStatus,
} from "../utils/protobuf.js";

// Bustang corridor colors
const ROUTE_COLORS = {
  "NORTH":    { name: "Bustang North",    color: "#0072CE", type: "bus" },
  "SOUTH":    { name: "Bustang South",    color: "#D22630", type: "bus" },
  "WEST":     { name: "Bustang West",     color: "#00833E", type: "bus" },
  "OUTRIDER": { name: "Bustang Outrider", color: "#F7941D", type: "bus" },
  "SNOWSTANG":{ name: "Snowstang",        color: "#5C88DA", type: "bus" },
};

export default class BustangAdapter extends BaseAdapter {
  static adapterId = "bustang";

  constructor(config, deps) {
    super(config, deps);
    this.lookup = new RouteLookup();
  }

  async onStart() {
    this.logger.info("Loading Bustang static GTFS data...");
    try {
      await this.lookup.loadFromDb(this.pg, this.id);
      this.logger.info(`  Loaded ${this.lookup.routeCount} routes, ${this.lookup.stopCount} stops`);
    } catch (err) {
      this.logger.warn({ err }, "Could not load from DB");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GTFS-RT FEED PARSING
  // ═══════════════════════════════════════════════════════════════════════════

  async parseFeed(feedType, buffer) {
    const feed = await decodeFeed(buffer);
    switch (feedType) {
      case "tripUpdates":      return extractTripUpdates(feed);
      case "vehiclePositions": return extractVehiclePositions(feed);
      default: return [];
    }
  }

  normalize(feedType, entities) {
    switch (feedType) {
      case "tripUpdates":      return this._normalizeTripUpdates(entities);
      case "vehiclePositions": return this._normalizeVehiclePositions(entities);
      default: return [];
    }
  }

  // ─── Trip Updates → Departures ─────────────────────────────────────────────

  _normalizeTripUpdates(entities) {
    const departures = [];

    for (const { tripUpdate } of entities) {
      const trip = tripUpdate?.trip;
      if (!trip) continue;

      const routeId   = trip.routeId || "";
      const routeInfo = this._resolveRoute(routeId);

      for (const stu of tripUpdate.stopTimeUpdate || []) {
        if (!stu.stopId) continue;

        const stop = this.lookup.getStop(stu.stopId);
        const { time: departureTime, delay } = resolveStopTime(stu.departure || stu.arrival);

        departures.push({
          tripId:       trip.tripId || "",
          routeId,
          routeName:    routeInfo.name,
          routeColor:   routeInfo.color,
          routeType:    routeInfo.type,
          stopId:       stu.stopId,
          stopName:     stop?.name || stu.stopId,
          direction:    trip.directionId === 0 ? "Northbound/Outbound" : "Southbound/Inbound",
          departureTime,
          delay:        delay ?? null,
          isRealtime:   true,
        });
      }
    }

    return departures;
  }

  // ─── Vehicle Positions ─────────────────────────────────────────────────────

  _normalizeVehiclePositions(entities) {
    return entities
      .filter(({ vehicle }) => vehicle?.position)
      .map(({ vehicle }) => {
        const trip  = vehicle.trip || {};
        const pos   = vehicle.position || {};
        const routeInfo = this._resolveRoute(trip.routeId || "");

        return {
          vehicleId: vehicle.vehicle?.id || "unknown",
          tripId:    trip.tripId   || "",
          routeId:   trip.routeId  || "",
          routeName: routeInfo.name,
          routeType: routeInfo.type,
          lat:       pos.latitude  || 0,
          lng:       pos.longitude || 0,
          bearing:   pos.bearing   ?? null,
          speed:     pos.speed     ?? null,
          stopId:    vehicle.stopId || null,
          status:    mapVehicleStatus(vehicle.currentStatus),
          timestamp: vehicle.timestamp ? Number(vehicle.timestamp) : Date.now() / 1000,
        };
      });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _resolveRoute(routeId) {
    // Check hardcoded corridor colors first
    const upper = (routeId || "").toUpperCase();
    for (const [key, info] of Object.entries(ROUTE_COLORS)) {
      if (upper.includes(key)) return info;
    }

    // RT feed appends a trailing "0" (e.g., NRTH0 → NRTH in static GTFS)
    // Try looking up the base route ID without the trailing digit
    const baseId = routeId.replace(/\d+$/, "");
    if (baseId !== routeId) {
      const upperBase = baseId.toUpperCase();
      for (const [key, info] of Object.entries(ROUTE_COLORS)) {
        if (upperBase.includes(key)) return info;
      }
      const dbRouteBase = this.lookup.getRoute(baseId);
      if (dbRouteBase) {
        return {
          name:  dbRouteBase.name  || baseId,
          color: dbRouteBase.color || "#0072CE",
          type:  "bus",
        };
      }
    }

    // Fall back to DB
    const dbRoute = this.lookup.getRoute(routeId);
    if (dbRoute) {
      return {
        name:  dbRoute.name  || routeId,
        color: dbRoute.color || "#0072CE",
        type:  "bus",
      };
    }

    return { name: routeId || "Bustang", color: "#0072CE", type: "bus" };
  }
}
