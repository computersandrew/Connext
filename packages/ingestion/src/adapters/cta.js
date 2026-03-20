// connext-ingestion/src/adapters/cta.js
// ─────────────────────────────────────────────────────────────────────────────
// CTA (Chicago) Adapter
//
// Quirks handled:
//   - CTA route_ids are color names ("Red", "Blue", "Brn", etc.)
//   - Single consolidated feed per feed type
//   - Direction mapped by run number conventions
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAdapter } from "../core/BaseAdapter.js";
import { RouteLookup } from "../utils/route-lookup.js";
import {
  decodeFeed, extractTripUpdates, extractVehiclePositions, extractAlerts,
  resolveStopTime, getTranslatedText, mapVehicleStatus,
} from "../utils/protobuf.js";

export default class CtaAdapter extends BaseAdapter {
  static adapterId = "cta";

  constructor(config, deps) {
    super(config, deps);
    this.lookup = new RouteLookup();
  }

  async onStart() {
    try {
      await this.lookup.loadFromDb(this.pg, this.id);
      this.logger.info(`CTA: Loaded ${this.lookup.routeCount} routes, ${this.lookup.stopCount} stops`);
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
          routeType: "rail",
          stopId: stu.stopId,
          stopName: stop?.name || stu.stopId,
          direction: trip.directionId === 1 ? "Southbound" : "Northbound",
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
      "Red":  { name: "Red Line",    color: "#C60C30" },
      "Blue": { name: "Blue Line",   color: "#00A1DE" },
      "Brn":  { name: "Brown Line",  color: "#62361B" },
      "G":    { name: "Green Line",  color: "#009B3A" },
      "Org":  { name: "Orange Line", color: "#F9461C" },
      "P":    { name: "Purple Line", color: "#522398" },
      "Pexp": { name: "Purple Exp",  color: "#522398" },
      "Pink": { name: "Pink Line",   color: "#E27EA6" },
      "Y":    { name: "Yellow Line", color: "#F9E300" },
    };
    return routes[routeId] || { name: routeId || "?", color: "#888888" };
  }

  _mapType(alert) {
    const text = getTranslatedText(alert.headerText).toLowerCase();
    if (text.includes("suspend") || text.includes("no service")) return "suspended";
    if (text.includes("delay")) return "delay";
    if (text.includes("reroute") || text.includes("shuttle")) return "reroute";
    return "planned_work";
  }
}
