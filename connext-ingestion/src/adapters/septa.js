// connext-ingestion/src/adapters/septa.js
// ─────────────────────────────────────────────────────────────────────────────
// SEPTA (Philadelphia) Adapter
//
// Quirks handled:
//   - No API key required (open feeds)
//   - Mixed system: subway, trolley, regional rail all in one feed
//   - Limited real-time coverage — some modes are schedule-only
//   - Route IDs are numeric strings for trolleys, abbreviations for subway
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAdapter } from "../core/BaseAdapter.js";
import { RouteLookup } from "../utils/route-lookup.js";
import {
  decodeFeed, extractTripUpdates, extractVehiclePositions, extractAlerts,
  resolveStopTime, getTranslatedText, mapVehicleStatus,
} from "../utils/protobuf.js";

export default class SeptaAdapter extends BaseAdapter {
  static adapterId = "septa";

  constructor(config, deps) {
    super(config, deps);
    this.lookup = new RouteLookup();
  }

  async onStart() {
    try {
      await this.lookup.loadFromDb(this.pg, this.id);
      this.logger.info(`SEPTA: Loaded ${this.lookup.routeCount} routes, ${this.lookup.stopCount} stops`);
    } catch (err) {
      this.logger.warn({ err }, "Could not load from DB");
    }
  }

  parseFeed(feedType, buffer) {
    const feed = decodeFeed(buffer);
    switch (feedType) {
      case "tripUpdates": return extractTripUpdates(feed);
      case "vehiclePositions": return extractVehiclePositions(feed);
      case "alerts": return extractAlerts(feed);
      default: return [];
    }
  }

  normalize(feedType, entities) {
    switch (feedType) {
      case "tripUpdates": return this._normalizeTripUpdates(entities);
      case "vehiclePositions": return this._normalizeVehiclePositions(entities);
      case "alerts": return this._normalizeAlerts(entities);
      default: return [];
    }
  }

  _normalizeTripUpdates(entities) {
    const departures = [];
    for (const { tripUpdate } of entities) {
      const trip = tripUpdate.trip;
      if (!trip) continue;
      const routeInfo = this._resolveRoute(trip.routeId);

      for (const stu of tripUpdate.stopTimeUpdate || []) {
        if (!stu.stopId) continue;
        const stop = this.lookup.getStop(stu.stopId);
        const { time: departureTime, delay } = resolveStopTime(stu.departure || stu.arrival);

        departures.push({
          tripId: trip.tripId,
          routeId: trip.routeId,
          routeName: routeInfo.name,
          routeColor: routeInfo.color,
          routeType: routeInfo.type,
          stopId: stu.stopId,
          stopName: stop?.name || stu.stopId,
          direction: trip.directionId === 0 ? "Northbound" : "Southbound",
          departureTime,
          delay: delay || null,
          isRealtime: true,
        });
      }
    }
    return departures;
  }

  _normalizeVehiclePositions(entities) {
    return entities.map(({ vehicle }) => {
      const trip = vehicle.trip || {};
      const pos = vehicle.position || {};
      const routeInfo = this._resolveRoute(trip.routeId);
      return {
        vehicleId: vehicle.vehicle?.id || "unknown",
        tripId: trip.tripId || "", routeId: trip.routeId || "",
        routeName: routeInfo.name,
        lat: pos.latitude || 0, lng: pos.longitude || 0,
        bearing: pos.bearing ?? null, speed: pos.speed ?? null,
        stopId: vehicle.stopId || null,
        status: mapVehicleStatus(vehicle.currentStatus),
        timestamp: vehicle.timestamp ? Number(vehicle.timestamp) : Date.now() / 1000,
      };
    });
  }

  _normalizeAlerts(entities) {
    return entities.map(({ id, alert }) => {
      const routeIds = [];
      const stopIds = [];
      for (const ie of alert.informedEntity || []) {
        if (ie.routeId) routeIds.push(ie.routeId);
        if (ie.stopId) stopIds.push(ie.stopId);
      }
      const uniqueRouteIds = [...new Set(routeIds)];
      return {
        alertId: id, routeIds: uniqueRouteIds,
        routeNames: uniqueRouteIds.map((r) => this._resolveRoute(r).name),
        stopIds: [...new Set(stopIds)],
        severity: getTranslatedText(alert.headerText).toLowerCase().includes("suspend") ? "severe" : "moderate",
        type: this._mapType(alert),
        headerText: getTranslatedText(alert.headerText),
        descriptionText: getTranslatedText(alert.descriptionText),
        activePeriods: (alert.activePeriod || []).map((p) => ({ start: p.start ? Number(p.start) : null, end: p.end ? Number(p.end) : null })),
        updatedAt: Date.now() / 1000,
      };
    });
  }

  _resolveRoute(routeId) {
    const routes = {
      "BSL":   { name: "Broad Street Line",  color: "#F58220", type: "subway" },
      "MFL":   { name: "Market-Frankford",    color: "#0070C0", type: "subway" },
      "NHSL":  { name: "Norristown High Speed", color: "#9E1F63", type: "light_rail" },
      "10":    { name: "Route 10 Trolley",    color: "#00A650", type: "trolley" },
      "11":    { name: "Route 11 Trolley",    color: "#00A650", type: "trolley" },
      "13":    { name: "Route 13 Trolley",    color: "#00A650", type: "trolley" },
      "34":    { name: "Route 34 Trolley",    color: "#00A650", type: "trolley" },
      "36":    { name: "Route 36 Trolley",    color: "#00A650", type: "trolley" },
      "AIR":   { name: "Airport Line",        color: "#91456C", type: "rail" },
      "TRE":   { name: "Trenton Line",        color: "#91456C", type: "rail" },
      "WAR":   { name: "Warminster Line",     color: "#91456C", type: "rail" },
      "LAN":   { name: "Lansdale/Doylestown", color: "#91456C", type: "rail" },
      "NOR":   { name: "Manayunk/Norristown", color: "#91456C", type: "rail" },
      "PAO":   { name: "Paoli/Thorndale",     color: "#91456C", type: "rail" },
      "MED":   { name: "Media/Wawa",          color: "#91456C", type: "rail" },
      "WIL":   { name: "Wilmington/Newark",   color: "#91456C", type: "rail" },
      "CHE":   { name: "Chestnut Hill East",  color: "#91456C", type: "rail" },
      "CHW":   { name: "Chestnut Hill West",  color: "#91456C", type: "rail" },
      "FOX":   { name: "Fox Chase",           color: "#91456C", type: "rail" },
      "CYN":   { name: "Cynwyd",              color: "#91456C", type: "rail" },
      "WHM":   { name: "West Trenton",        color: "#91456C", type: "rail" },
    };

    if (routes[routeId]) return routes[routeId];

    // Fallback: try DB lookup
    const dbRoute = this.lookup.getRoute(routeId);
    if (dbRoute) return { name: dbRoute.name, color: dbRoute.color, type: "bus" };
    return { name: routeId || "?", color: "#888888", type: "other" };
  }

  _mapType(alert) {
    const text = getTranslatedText(alert.headerText).toLowerCase();
    if (text.includes("suspend")) return "suspended";
    if (text.includes("delay")) return "delay";
    if (text.includes("detour") || text.includes("reroute")) return "reroute";
    return "planned_work";
  }
}
