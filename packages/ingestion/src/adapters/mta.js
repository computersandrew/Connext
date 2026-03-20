// connext-ingestion/src/adapters/mta.js
// ─────────────────────────────────────────────────────────────────────────────
// MTA (New York City) Adapter
//
// Quirks handled:
//   - MTA splits subway feeds by line group (1-6, A-C-E, B-D-F-M, etc.)
//   - Uses NYCT extensions in protobuf (direction, train assignments)
//   - Stop IDs have N/S suffix for direction (e.g., "127N" = 42 St northbound)
//   - Alert feed is separate from trip updates
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAdapter } from "../core/BaseAdapter.js";
import { RouteLookup } from "../utils/route-lookup.js";
import {
  decodeFeed, extractTripUpdates, extractVehiclePositions, extractAlerts,
  resolveStopTime, getTranslatedText, mapVehicleStatus, mapRouteType,
} from "../utils/protobuf.js";

export default class MtaAdapter extends BaseAdapter {
  static adapterId = "mta";

  constructor(config, deps) {
    super(config, deps);
    this.lookup = new RouteLookup();

    // MTA direction mapping: stop_id suffix → direction label
    this.directionMap = { N: "Uptown & The Bronx", S: "Downtown & Brooklyn" };
  }

  async onStart() {
    this.logger.info("Loading MTA static GTFS data...");
    try {
      await this.lookup.loadFromDb(this.pg, this.id);
      this.logger.info(`  Loaded ${this.lookup.routeCount} routes, ${this.lookup.stopCount} stops, ${this.lookup.tripCount} trips`);
    } catch (err) {
      this.logger.warn({ err }, "Could not load from DB — using empty lookup (feeds will have limited enrichment)");
    }
  }

  async parseFeed(feedType, buffer) {
    const feed = await decodeFeed(buffer);

    switch (feedType) {
      case "tripUpdates":
        return extractTripUpdates(feed);
      case "vehiclePositions":
        return extractVehiclePositions(feed);
      case "alerts":
        return extractAlerts(feed);
      default:
        return [];
    }
  }

  normalize(feedType, entities) {
    switch (feedType) {
      case "tripUpdates":
        return this._normalizeTripUpdates(entities);
      case "vehiclePositions":
        return this._normalizeVehiclePositions(entities);
      case "alerts":
        return this._normalizeAlerts(entities);
      default:
        return [];
    }
  }

  // ─── Trip Updates ───────────────────────────────────────────────────────

  _normalizeTripUpdates(entities) {
    const departures = [];

    for (const { tripUpdate } of entities) {
      const trip = tripUpdate.trip;
      if (!trip) continue;

      const tripId = trip.tripId;
      const routeId = trip.routeId;

      // Resolve from static GTFS
      const routeInfo = this.lookup.resolveTrip(tripId);

      // MTA-specific: route_id in the feed is the line letter/number
      const routeName = routeId || routeInfo.routeName;

      for (const stu of tripUpdate.stopTimeUpdate || []) {
        const stopId = stu.stopId;
        if (!stopId) continue;

        // MTA stop_id has N/S suffix for direction
        const baseStopId = stopId.replace(/[NS]$/, "");
        const dirSuffix = stopId.slice(-1);
        const stop = this.lookup.getStop(baseStopId) || this.lookup.getStop(stopId);

        const { time: departureTime, delay } = resolveStopTime(stu.departure || stu.arrival);

        departures.push({
          tripId,
          routeId: routeId || routeInfo.routeId,
          routeName,
          routeColor: this._getLineColor(routeName),
          routeType: "subway",
          stopId: baseStopId,
          stopName: stop?.name || baseStopId,
          direction: this.directionMap[dirSuffix] || routeInfo.direction || "",
          departureTime,
          delay: delay || null,
          isRealtime: true,
        });
      }
    }

    return departures;
  }

  // ─── Vehicle Positions ──────────────────────────────────────────────────

  _normalizeVehiclePositions(entities) {
    return entities.map(({ vehicle }) => {
      const trip = vehicle.trip || {};
      const pos = vehicle.position || {};
      const routeInfo = this.lookup.resolveTrip(trip.tripId);

      return {
        vehicleId: vehicle.vehicle?.id || vehicle.vehicle?.label || "unknown",
        tripId: trip.tripId || "",
        routeId: trip.routeId || routeInfo.routeId || "",
        routeName: trip.routeId || routeInfo.routeName,
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

  // ─── Alerts ─────────────────────────────────────────────────────────────

  _normalizeAlerts(entities) {
    return entities.map(({ id, alert }) => {
      const routeIds = [];
      const stopIds = [];

      for (const ie of alert.informedEntity || []) {
        if (ie.routeId) routeIds.push(ie.routeId);
        if (ie.stopId) stopIds.push(ie.stopId);
      }

      return {
        alertId: id,
        routeIds: [...new Set(routeIds)],
        routeNames: [...new Set(routeIds)], // MTA route_id IS the name (A, B, 1, 2, etc.)
        stopIds: [...new Set(stopIds)],
        severity: this._mapAlertSeverity(alert),
        type: this._mapAlertType(alert),
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

  // ─── MTA-specific helpers ───────────────────────────────────────────────

  _getLineColor(routeName) {
    const colors = {
      "1": "#EE352E", "2": "#EE352E", "3": "#EE352E",
      "4": "#00933C", "5": "#00933C", "6": "#00933C",
      "7": "#B933AD",
      "A": "#0039A6", "C": "#0039A6", "E": "#0039A6",
      "B": "#FF6319", "D": "#FF6319", "F": "#FF6319", "M": "#FF6319",
      "G": "#6CBE45",
      "J": "#996633", "Z": "#996633",
      "L": "#A7A9AC",
      "N": "#FCCC0A", "Q": "#FCCC0A", "R": "#FCCC0A", "W": "#FCCC0A",
      "S": "#808183", "SI": "#0039A6",
    };
    return colors[routeName] || "#888888";
  }

  _mapAlertSeverity(alert) {
    const text = getTranslatedText(alert.headerText).toLowerCase();
    if (text.includes("suspend") || text.includes("no service")) return "severe";
    if (text.includes("delay") || text.includes("reroute")) return "moderate";
    return "info";
  }

  _mapAlertType(alert) {
    const text = getTranslatedText(alert.headerText).toLowerCase();
    if (text.includes("suspend") || text.includes("no service")) return "suspended";
    if (text.includes("delay")) return "delay";
    if (text.includes("reroute") || text.includes("shuttle")) return "reroute";
    if (text.includes("planned") || text.includes("work")) return "planned_work";
    return "other";
  }

  async onFeedProcessed(feedType, normalized, elapsedMs) {
    this.logger.debug(
      { feedType, count: normalized.length, elapsedMs },
      `MTA ${feedType}: ${normalized.length} entities in ${elapsedMs}ms`
    );
  }
}
