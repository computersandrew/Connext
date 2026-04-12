// packages/ingestion/src/adapters/rtd.js
// ─────────────────────────────────────────────────────────────────────────────
// RTD Denver (Regional Transportation District) Adapter
//
// Covers the full Denver metro transit network:
//   Light rail (W, E, R, H, C, D, F, L lines)
//   Commuter rail (University of Colorado A line, B line, G line, N line)
//   Bus Rapid Transit (Flatiron Flyer, MAX)
//   Local and regional bus routes
//
// Uses standard GTFS-RT protobuf feeds — no API key required.
// Feeds: https://open-data.rtd-denver.com/files/gtfs-rt/rtd/
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAdapter } from "../core/BaseAdapter.js";
import { RouteLookup } from "../utils/route-lookup.js";
import {
  decodeFeed, extractTripUpdates, extractVehiclePositions, extractAlerts,
  resolveStopTime, getTranslatedText, mapVehicleStatus,
} from "../utils/protobuf.js";

// RTD rail/BRT route colors (from GTFS routes.txt)
const ROUTE_COLORS = {
  // Light Rail
  "W":  { name: "W Line",           color: "#E8CD04", type: "light_rail" },
  "E":  { name: "E Line",           color: "#F7941D", type: "light_rail" },
  "R":  { name: "R Line",           color: "#E31837", type: "light_rail" },
  "H":  { name: "H Line",           color: "#00843D", type: "light_rail" },
  "C":  { name: "C Line",           color: "#F7941D", type: "light_rail" },
  "D":  { name: "D Line",           color: "#0033A0", type: "light_rail" },
  "F":  { name: "F Line",           color: "#84329B", type: "light_rail" },
  "L":  { name: "L Line",           color: "#007FC5", type: "light_rail" },
  // Commuter Rail
  "A":  { name: "University of Colorado A Line", color: "#007FC5", type: "rail" },
  "B":  { name: "B Line",           color: "#00843D", type: "rail" },
  "G":  { name: "G Line",           color: "#84329B", type: "rail" },
  "N":  { name: "N Line",           color: "#E31837", type: "rail" },
  // BRT
  "FF": { name: "Flatiron Flyer",   color: "#007FC5", type: "bus" },
};

export default class RtdAdapter extends BaseAdapter {
  static adapterId = "rtd";

  constructor(config, deps) {
    super(config, deps);
    this.lookup = new RouteLookup();
  }

  async onStart() {
    this.logger.info("Loading RTD Denver static GTFS data...");
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
      case "alerts":           return extractAlerts(feed);
      default: return [];
    }
  }

  normalize(feedType, entities) {
    switch (feedType) {
      case "tripUpdates":      return this._normalizeTripUpdates(entities);
      case "vehiclePositions": return this._normalizeVehiclePositions(entities);
      case "alerts":           return this._normalizeAlerts(entities);
      default: return [];
    }
  }

  // ─── Trip Updates → Departures ─────────────────────────────────────────────

  _normalizeTripUpdates(entities) {
    const departures = [];

    for (const { tripUpdate } of entities) {
      const trip = tripUpdate?.trip;
      if (!trip) continue;

      const routeId = trip.routeId || "";
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
          direction:    trip.directionId === 0 ? "Outbound" : "Inbound",
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
        const trip = vehicle.trip || {};
        const pos  = vehicle.position || {};
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

  // ─── Alerts ────────────────────────────────────────────────────────────────

  _normalizeAlerts(entities) {
    return entities.map(({ id, alert }) => {
      const routeIds = [];
      const stopIds  = [];
      for (const ie of alert.informedEntity || []) {
        if (ie.routeId) routeIds.push(ie.routeId);
        if (ie.stopId)  stopIds.push(ie.stopId);
      }
      const uniqueRouteIds = [...new Set(routeIds)];

      return {
        alertId:         id || `rtd-${Date.now()}`,
        routeIds:        uniqueRouteIds,
        routeNames:      uniqueRouteIds.map((r) => this._resolveRoute(r).name),
        stopIds:         [...new Set(stopIds)],
        severity:        this._mapSeverity(alert.cause),
        type:            "disruption",
        headerText:      getTranslatedText(alert.headerText)      || "",
        descriptionText: getTranslatedText(alert.descriptionText) || "",
        activePeriods:   (alert.activePeriod || []).map((p) => ({
          start: p.start ? Number(p.start) : null,
          end:   p.end   ? Number(p.end)   : null,
        })),
        updatedAt: Date.now() / 1000,
      };
    }).filter((a) => a.headerText || a.descriptionText);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _resolveRoute(routeId) {
    if (ROUTE_COLORS[routeId]) return ROUTE_COLORS[routeId];

    // Fall back to DB
    const dbRoute = this.lookup.getRoute(routeId);
    if (dbRoute) {
      return {
        name:  dbRoute.name  || routeId,
        color: dbRoute.color || "#0033A0",
        type:  dbRoute.type  || "bus",
      };
    }

    return { name: routeId || "?", color: "#0033A0", type: "bus" };
  }

  _mapSeverity(cause) {
    // GTFS-RT cause values: 1=UNKNOWN, 2=OTHER_CAUSE, 3=TECHNICAL_PROBLEM,
    // 4=STRIKE, 5=DEMONSTRATION, 6=ACCIDENT, 7=HOLIDAY, 8=WEATHER,
    // 9=MAINTENANCE, 10=CONSTRUCTION, 11=POLICE_ACTIVITY, 12=MEDICAL_EMERGENCY
    if ([4, 5, 6, 12].includes(cause)) return "severe";
    if ([3, 8, 9, 10, 11].includes(cause)) return "moderate";
    return "info";
  }
}
