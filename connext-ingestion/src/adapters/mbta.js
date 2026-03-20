// connext-ingestion/src/adapters/mbta.js
// ─────────────────────────────────────────────────────────────────────────────
// MBTA (Boston) Adapter
//
// Quirks handled:
//   - MBTA provides single consolidated feeds (not split by line)
//   - Route IDs are descriptive ("Red", "Orange", "Green-B", etc.)
//   - Stop IDs use place-based names ("place-pktrm" for Park Street)
//   - Parent stations group child stops
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAdapter } from "../core/BaseAdapter.js";
import { RouteLookup } from "../utils/route-lookup.js";
import {
  decodeFeed, extractTripUpdates, extractVehiclePositions, extractAlerts,
  resolveStopTime, getTranslatedText, mapVehicleStatus,
} from "../utils/protobuf.js";

export default class MbtaAdapter extends BaseAdapter {
  static adapterId = "mbta";

  constructor(config, deps) {
    super(config, deps);
    this.lookup = new RouteLookup();
  }

  async onStart() {
    this.logger.info("Loading MBTA static GTFS data...");
    try {
      await this.lookup.loadFromDb(this.pg, this.id);
      this.logger.info(`  Loaded ${this.lookup.routeCount} routes, ${this.lookup.stopCount} stops`);
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

      const routeId = trip.routeId;
      const routeInfo = this._resolveRoute(routeId);

      for (const stu of tripUpdate.stopTimeUpdate || []) {
        const stopId = stu.stopId;
        if (!stopId) continue;

        const stop = this.lookup.getStop(stopId);
        const { time: departureTime, delay } = resolveStopTime(stu.departure || stu.arrival);

        departures.push({
          tripId: trip.tripId,
          routeId,
          routeName: routeInfo.name,
          routeColor: routeInfo.color,
          routeType: routeInfo.type,
          stopId,
          stopName: stop?.name || stopId,
          direction: trip.directionId === 0 ? "Outbound" : "Inbound",
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
        tripId: trip.tripId || "",
        routeId: trip.routeId || "",
        routeName: routeInfo.name,
        lat: pos.latitude || 0,
        lng: pos.longitude || 0,
        bearing: pos.bearing ?? null,
        speed: pos.speed ?? null,
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
        alertId: id,
        routeIds: uniqueRouteIds,
        routeNames: uniqueRouteIds.map((r) => this._resolveRoute(r).name),
        stopIds: [...new Set(stopIds)],
        severity: this._mapSeverity(alert),
        type: this._mapType(alert),
        headerText: getTranslatedText(alert.headerText),
        descriptionText: getTranslatedText(alert.descriptionText),
        activePeriods: (alert.activePeriod || []).map((p) => ({
          start: p.start ? Number(p.start) : null,
          end: p.end ? Number(p.end) : null,
        })),
        updatedAt: Date.now() / 1000,
      };
    });
  }

  // ─── MBTA-specific helpers ──────────────────────────────────────────────

  _resolveRoute(routeId) {
    const routes = {
      "Red":     { name: "Red Line",    color: "#DA291C", type: "subway" },
      "Orange":  { name: "Orange Line", color: "#ED8B00", type: "subway" },
      "Blue":    { name: "Blue Line",   color: "#003DA5", type: "subway" },
      "Green-B": { name: "Green Line B", color: "#00843D", type: "light_rail" },
      "Green-C": { name: "Green Line C", color: "#00843D", type: "light_rail" },
      "Green-D": { name: "Green Line D", color: "#00843D", type: "light_rail" },
      "Green-E": { name: "Green Line E", color: "#00843D", type: "light_rail" },
      "Mattapan": { name: "Mattapan",   color: "#DA291C", type: "light_rail" },
    };

    if (routes[routeId]) return routes[routeId];

    // Silver line and bus routes
    if (routeId?.startsWith("7")) return { name: `Silver Line ${routeId}`, color: "#7C878E", type: "bus" };

    // Commuter rail
    if (routeId?.startsWith("CR-")) return { name: routeId.replace("CR-", ""), color: "#80276C", type: "rail" };

    // Fallback
    const dbRoute = this.lookup.getRoute(routeId);
    return dbRoute
      ? { name: dbRoute.name, color: dbRoute.color, type: dbRoute.type }
      : { name: routeId || "?", color: "#888888", type: "other" };
  }

  _mapSeverity(alert) {
    const cause = alert.cause;
    const effect = alert.effect;
    if (effect === 1) return "severe";     // NO_SERVICE
    if (effect === 2) return "moderate";   // REDUCED_SERVICE
    if (effect === 6) return "moderate";   // SIGNIFICANT_DELAYS
    return "info";
  }

  _mapType(alert) {
    const effect = alert.effect;
    if (effect === 1) return "suspended";
    if (effect === 6) return "delay";
    if (effect === 4) return "reroute";        // DETOUR
    if (effect === 7) return "planned_work";   // ADDITIONAL_SERVICE (often planned)
    return "other";
  }
}
