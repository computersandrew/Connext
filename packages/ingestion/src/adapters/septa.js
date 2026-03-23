// connext-ingestion/src/adapters/septa.js
// ─────────────────────────────────────────────────────────────────────────────
// SEPTA (Philadelphia) Adapter — HYBRID
//
// Uses SEPTA's proprietary JSON APIs as PRIMARY data source:
//   - TrainView: all regional rail train positions/status
//   - TransitView: bus/trolley locations by route
//   - Arrivals: station departure boards
//   - Alerts: service disruptions (JSON)
//
// Falls back to GTFS-RT protobuf feeds where available.
// No API key required for any SEPTA endpoint.
//
// API docs: https://www3.septa.org/ and http://apitest.septa.org/
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAdapter } from "../core/BaseAdapter.js";
import { RouteLookup } from "../utils/route-lookup.js";
import {
  decodeFeed, extractTripUpdates, extractVehiclePositions, extractAlerts,
  resolveStopTime, getTranslatedText, mapVehicleStatus,
} from "../utils/protobuf.js";

// SEPTA JSON API base URLs
const SEPTA_API = {
  trainView:      "https://www3.septa.org/api/TrainView/index.php",
  transitViewAll: "https://www3.septa.org/api/TransitViewAll/",
  arrivals:       "https://www3.septa.org/api/Arrivals/index.php",
  alerts:         "https://www3.septa.org/api/Alerts/get_alert_data.php",
  busDetours:     "https://www3.septa.org/api/BusDetours/",
};

// Routes we actively poll TransitView for (subway + trolley lines)
const TRANSIT_ROUTES = ["MFL", "BSL", "NHSL", "10", "11", "13", "34", "36", "101", "102"];

// Key stations to poll Arrivals for (gives us departure boards)
let KEY_STATIONS = [
  "Suburban Station", "30th Street Station", "Jefferson Station",
  "Temple University", "Fern Rock Transportation Center",
  "69th Street Transportation Center",
];

export default class SeptaAdapter extends BaseAdapter {
  static adapterId = "septa";

  constructor(config, deps) {
    super(config, deps);
    this.lookup = new RouteLookup();
    this._jsonTimers = [];
  }

  async onStart() {
    this.logger.info("Loading SEPTA static GTFS data...");
    try {
      await this.lookup.loadFromDb(this.pg, this.id);
      // Load all SEPTA station names for arrivals polling
      if (this.lookup.stopCount > 0) {
        const allNames = [];
        for (const [id, stop] of this.lookup.stops) {
          if (stop.name && !allNames.includes(stop.name)) allNames.push(stop.name);
        }
        if (allNames.length > 0) {
          KEY_STATIONS = allNames;
          this.logger.info(`  Polling arrivals for ${KEY_STATIONS.length} stations`);
        }
      }
      this.logger.info(`  Loaded ${this.lookup.routeCount} routes, ${this.lookup.stopCount} stops`);
    } catch (err) {
      this.logger.warn({ err }, "Could not load from DB — running with built-in route data");
    }

    // Start JSON API polling loops (separate from GTFS-RT polling in BaseAdapter)
    this._startJsonPolling();
  }

  async onStop() {
    this._jsonTimers.forEach(clearInterval);
    this._jsonTimers = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  JSON API POLLING — primary data source
  // ═══════════════════════════════════════════════════════════════════════════

  _startJsonPolling() {
    // TrainView — all regional rail trains, every 30s
    this._pollJson("trainView", () => this._fetchTrainView(), 30_000);

    // TransitView — subway/trolley vehicle positions, every 30s
    this._pollJson("transitView", () => this._fetchTransitView(), 30_000);

    // Alerts — service disruptions, every 60s
    this._pollJson("alerts", () => this._fetchAlerts(), 60_000);

    // Arrivals — departure boards for key stations, every 30s
    this._pollJson("arrivals", () => this._fetchArrivals(), 30_000);
  }

  _pollJson(name, fn, intervalMs) {
    // Run immediately, then on interval
    fn().catch((err) => this.logger.error({ err }, `SEPTA JSON ${name} error`));
    const timer = setInterval(() => {
      fn().catch((err) => this.logger.error({ err }, `SEPTA JSON ${name} error`));
    }, intervalMs);
    this._jsonTimers.push(timer);
    this.logger.info(`  → ${name} (JSON API) every ${intervalMs / 1000}s`);
  }

  // ─── TrainView: Regional Rail ──────────────────────────────────────────

  async _fetchTrainView() {
    const resp = await this._jsonGet(SEPTA_API.trainView);
    if (!Array.isArray(resp)) return;

    const departures = [];
    const vehicles = [];

    for (const train of resp) {
      const routeName = train.dest || "Unknown";
      const routeInfo = this._resolveRoute(train.line || "RR");
      const delay = this._parseDelay(train.late);

      // Vehicle position
      if (train.lat && train.lon) {
        vehicles.push({
          vehicleId: String(train.trainno || ""),
          tripId: String(train.trainno || ""),
          routeId: train.line || "RR",
          routeName: train.line || "Regional Rail",
          lat: parseFloat(train.lat),
          lng: parseFloat(train.lon),
          bearing: null,
          speed: null,
          stopId: train.nextstop || null,
          status: train.late > 0 ? "IN_TRANSIT" : "IN_TRANSIT",
          timestamp: Date.now() / 1000,
        });
      }

      // Departure info
      departures.push({
        tripId: String(train.trainno || ""),
        routeId: train.line || "RR",
        routeName: train.line || "Regional Rail",
        routeColor: routeInfo.color,
        routeType: "rail",
        stopId: train.nextstop || "",
        stopName: train.nextstop || "",
        direction: `${train.source || ""} → ${train.dest || ""}`,
        departureTime: train.sched_time ? this._parseTime(train.sched_time) : null,
        delay: delay,
        isRealtime: true,
      });
    }

    // Write to Redis
    const pipeline = this.redis.pipeline();
    const ttl = 45;

    if (vehicles.length > 0) {
      pipeline.setex(`vehicles:${this.id}:regional_rail`, ttl, JSON.stringify(vehicles));
    }

    // Group departures by next stop
    const byStop = {};
    for (const dep of departures) {
      const key = `departures:${this.id}:${dep.stopId}`;
      if (!byStop[key]) byStop[key] = [];
      byStop[key].push(dep);
    }
    for (const [key, deps] of Object.entries(byStop)) {
      deps.sort((a, b) => (a.departureTime || Infinity) - (b.departureTime || Infinity));
      pipeline.setex(key, ttl, JSON.stringify(deps));
    }

    pipeline.setex(`trainview:${this.id}:_summary`, ttl,
      JSON.stringify({ trains: resp.length, updatedAt: Date.now() })
    );

    await pipeline.exec();
    this.logger.debug(`TrainView: ${resp.length} trains, ${vehicles.length} with positions`);
  }

  // ─── TransitView: Subway/Trolley positions ─────────────────────────────

  async _fetchTransitView() {
    const resp = await this._jsonGet(SEPTA_API.transitViewAll);
    if (!resp || typeof resp !== "object") return;

    const pipeline = this.redis.pipeline();
    const ttl = 45;
    let totalVehicles = 0;

    // TransitViewAll returns { "routes": [ { "route_id": "...", ... } ] }
    // or it may return an array of route objects directly
    const routeData = Array.isArray(resp) ? resp : resp.routes || [];

    for (const routeObj of routeData) {
      // Each route object has the route ID as a key
      for (const [routeId, vehicleList] of Object.entries(routeObj)) {
        if (!Array.isArray(vehicleList)) continue;

        // Only cache subway/trolley routes we care about
        const isTracked = TRANSIT_ROUTES.includes(routeId);
        const routeInfo = this._resolveRoute(routeId);

        const vehicles = vehicleList.map((v) => ({
          vehicleId: String(v.VehicleID || v.vehicleid || ""),
          tripId: String(v.trip || v.Trip || ""),
          routeId: routeId,
          routeName: routeInfo.name,
          lat: parseFloat(v.lat || v.Lat || 0),
          lng: parseFloat(v.lng || v.Lng || 0),
          bearing: v.heading ? parseFloat(v.heading) : null,
          speed: null,
          stopId: v.next_stop_id || null,
          status: v.Direction === "0" ? "Outbound" : "Inbound",
          timestamp: Date.now() / 1000,
        })).filter((v) => v.lat !== 0 && v.lng !== 0);

        if (vehicles.length > 0 && isTracked) {
          pipeline.setex(`vehicles:${this.id}:${routeId}`, ttl, JSON.stringify(vehicles));
          totalVehicles += vehicles.length;
        }
      }
    }

    pipeline.setex(`transitview:${this.id}:_summary`, ttl,
      JSON.stringify({ vehicles: totalVehicles, updatedAt: Date.now() })
    );
    await pipeline.exec();
    this.logger.debug(`TransitView: ${totalVehicles} tracked vehicles`);
  }

  // ─── Arrivals: Station departure boards ────────────────────────────────

  async _fetchArrivals() {
    const pipeline = this.redis.pipeline();
    const ttl = 45;

    for (const station of KEY_STATIONS) {
      try {
        const url = `${SEPTA_API.arrivals}?station=${encodeURIComponent(station)}&results=10`;
        const resp = await this._jsonGet(url);

        // Response: { "Station Departures: date": [ { "Northbound": [...], "Southbound": [...] } ] }
        const departures = [];
        const outerKey = Object.keys(resp || {})[0];
        if (!outerKey) continue;

        const wrapper = resp[outerKey];
        const directionObj = Array.isArray(wrapper) ? wrapper[0] : wrapper;
        if (!directionObj) continue;

        for (const [direction, trains] of Object.entries(directionObj)) {
          if (!Array.isArray(trains)) continue;

          for (const train of trains) {
            const routeInfo = this._resolveRoute(train.line || "RR");
            const delay = this._parseDelay(train.status);

            departures.push({
              tripId: String(train.train_id || ""),
              routeId: train.line || "RR",
              routeName: routeInfo.name,
              routeColor: routeInfo.color,
              routeType: "rail",
              stopId: station.replace(/\s+/g, "_").toLowerCase(),
              stopName: station,
              direction: `${direction} → ${train.destination || ""}`,
              departureTime: train.depart_time ? this._parseTime(train.depart_time) : null,
              delay: delay,
              isRealtime: true,
              _track: train.track || null,
              _platform: train.platform || null,
              _status: train.status || null,
            });
          }
        }

        if (departures.length > 0) {
          departures.sort((a, b) => (a.departureTime || Infinity) - (b.departureTime || Infinity));
          const stationKey = station.replace(/\s+/g, "_").toLowerCase();

          // Write both station-name key and GTFS stop ID key
          pipeline.setex(`departures:${this.id}:station:${stationKey}`, ttl, JSON.stringify(departures));

          // Also look up the GTFS stop ID for this station and write there too
          if (this.lookup) {
            const gtfsStop = this.lookup.getStopByName(station);
            if (gtfsStop) {
              pipeline.setex(`departures:${this.id}:${gtfsStop.id}`, ttl, JSON.stringify(departures));
            }
          }
        }
      } catch (err) {
        this.logger.debug({ station, err: err.message }, `Arrivals fetch failed for ${station}`);
      }
    }

    await pipeline.exec();
  }

  // ─── Alerts: Service disruptions ───────────────────────────────────────

  async _fetchAlerts() {
    const resp = await this._jsonGet(SEPTA_API.alerts);
    if (!Array.isArray(resp)) return;

    const alerts = resp.map((alert) => {
      const routeId = alert.route_id || "";
      const routeInfo = this._resolveRoute(routeId.replace(/^rr_route_/, "").replace(/^bus_route_/, ""));

      return {
        alertId: `septa-${routeId}-${Date.now()}`,
        routeIds: [routeId],
        routeNames: [routeInfo.name || routeId],
        stopIds: [],
        severity: this._mapAlertSeverity(alert),
        type: this._mapAlertType(alert),
        headerText: alert.current_message || alert.advisory_message || "",
        descriptionText: alert.detour_message || alert.snow_message || "",
        activePeriods: [{
          start: alert.last_updated ? new Date(alert.last_updated).getTime() / 1000 : Date.now() / 1000,
          end: null,
        }],
        updatedAt: alert.last_updated ? new Date(alert.last_updated).getTime() / 1000 : Date.now() / 1000,
      };
    }).filter((a) => a.headerText || a.descriptionText); // Only keep alerts with actual content

    const pipeline = this.redis.pipeline();
    pipeline.setex(`alerts:${this.id}`, 120, JSON.stringify(alerts));
    await pipeline.exec();
    this.logger.debug(`Alerts: ${alerts.length} active`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GTFS-RT FALLBACK — BaseAdapter still polls these if configured
  // ═══════════════════════════════════════════════════════════════════════════

  async parseFeed(feedType, buffer) {
    const feed = await decodeFeed(buffer);
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
          tripId: trip.tripId, routeId: trip.routeId,
          routeName: routeInfo.name, routeColor: routeInfo.color, routeType: routeInfo.type,
          stopId: stu.stopId, stopName: stop?.name || stu.stopId,
          direction: trip.directionId === 0 ? "Northbound" : "Southbound",
          departureTime, delay: delay || null, isRealtime: true,
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
        severity: "info", type: "other",
        headerText: getTranslatedText(alert.headerText),
        descriptionText: getTranslatedText(alert.descriptionText),
        activePeriods: (alert.activePeriod || []).map((p) => ({
          start: p.start ? Number(p.start) : null, end: p.end ? Number(p.end) : null,
        })),
        updatedAt: Date.now() / 1000,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  async _jsonGet(url) {
    const resp = await this.fetcher.fetchFeed(url, { type: "none" });
    return JSON.parse(resp.toString("utf-8"));
  }

  _parseDelay(lateValue) {
    if (lateValue === undefined || lateValue === null) return null;
    if (typeof lateValue === "string") {
      if (lateValue.toLowerCase() === "on time") return 0;
      const num = parseInt(lateValue);
      return isNaN(num) ? null : num * 60; // SEPTA reports delay in minutes
    }
    if (typeof lateValue === "number") {
      return lateValue * 60; // Convert minutes to seconds
    }
    return null;
  }

  _parseTime(timeStr) {
    if (!timeStr) return null;
    try {
      // SEPTA times are like "3:30 pm" or "15:30"
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

      // Try parsing with AM/PM
      const parsed = new Date(`${dateStr} ${timeStr}`);
      if (!isNaN(parsed.getTime())) return Math.floor(parsed.getTime() / 1000);

      // Try 24hr format
      const match = timeStr.match(/(\d{1,2}):(\d{2})/);
      if (match) {
        const d = new Date(now);
        d.setHours(parseInt(match[1]), parseInt(match[2]), 0, 0);
        return Math.floor(d.getTime() / 1000);
      }
    } catch (e) {}
    return null;
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
      "101":   { name: "Route 101",           color: "#00A650", type: "trolley" },
      "102":   { name: "Route 102",           color: "#00A650", type: "trolley" },
      "AIR":   { name: "Airport Line",        color: "#91456C", type: "rail" },
      "Airport": { name: "Airport Line",      color: "#91456C", type: "rail" },
      "CHE":   { name: "Chestnut Hill East",  color: "#91456C", type: "rail" },
      "Chestnut Hill East": { name: "Chestnut Hill East", color: "#91456C", type: "rail" },
      "CHW":   { name: "Chestnut Hill West",  color: "#91456C", type: "rail" },
      "Chestnut Hill West": { name: "Chestnut Hill West", color: "#91456C", type: "rail" },
      "CYN":   { name: "Cynwyd",              color: "#91456C", type: "rail" },
      "Cynwyd": { name: "Cynwyd",             color: "#91456C", type: "rail" },
      "FOX":   { name: "Fox Chase",           color: "#91456C", type: "rail" },
      "Fox Chase": { name: "Fox Chase",       color: "#91456C", type: "rail" },
      "LAN":   { name: "Lansdale/Doylestown", color: "#91456C", type: "rail" },
      "Lansdale/Doylestown": { name: "Lansdale/Doylestown", color: "#91456C", type: "rail" },
      "MED":   { name: "Media/Wawa",          color: "#91456C", type: "rail" },
      "Media/Wawa": { name: "Media/Wawa",     color: "#91456C", type: "rail" },
      "NOR":   { name: "Manayunk/Norristown", color: "#91456C", type: "rail" },
      "Manayunk/Norristown": { name: "Manayunk/Norristown", color: "#91456C", type: "rail" },
      "PAO":   { name: "Paoli/Thorndale",     color: "#91456C", type: "rail" },
      "Paoli/Thorndale": { name: "Paoli/Thorndale", color: "#91456C", type: "rail" },
      "TRE":   { name: "Trenton",             color: "#91456C", type: "rail" },
      "Trenton": { name: "Trenton",           color: "#91456C", type: "rail" },
      "WAR":   { name: "Warminster",          color: "#91456C", type: "rail" },
      "Warminster": { name: "Warminster",     color: "#91456C", type: "rail" },
      "WIL":   { name: "Wilmington/Newark",   color: "#91456C", type: "rail" },
      "Wilmington/Newark": { name: "Wilmington/Newark", color: "#91456C", type: "rail" },
      "WHM":   { name: "West Trenton",        color: "#91456C", type: "rail" },
      "West Trenton": { name: "West Trenton", color: "#91456C", type: "rail" },
      "RR":    { name: "Regional Rail",       color: "#91456C", type: "rail" },
    };

    if (routes[routeId]) return routes[routeId];
    const dbRoute = this.lookup.getRoute(routeId);
    if (dbRoute) return { name: dbRoute.name, color: dbRoute.color, type: dbRoute.type || "other" };
    return { name: routeId || "?", color: "#888888", type: "other" };
  }

  _mapAlertSeverity(alert) {
    const msg = (alert.current_message || "").toLowerCase();
    if (msg.includes("suspend") || msg.includes("no service")) return "severe";
    if (msg.includes("delay") || msg.includes("detour")) return "moderate";
    return "info";
  }

  _mapAlertType(alert) {
    const msg = (alert.current_message || "").toLowerCase();
    if (msg.includes("suspend")) return "suspended";
    if (msg.includes("delay")) return "delay";
    if (msg.includes("detour")) return "reroute";
    return "planned_work";
  }
}
