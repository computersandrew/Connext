// connext-ingestion/src/adapters/cta.js
// ─────────────────────────────────────────────────────────────────────────────
// CTA (Chicago) Adapter — HYBRID
//
// CTA does NOT publish native GTFS-RT feeds.
// Uses CTA's proprietary JSON APIs as PRIMARY data source:
//   - Train Tracker Arrivals: predictions for all stations
//   - Train Tracker Locations: live train positions by route
//   - Customer Alerts: service disruptions
//
// API docs: transitchicago.com/assets/1/6/cta_Train_Tracker_API_Developer_Guide_and_Documentation.pdf
//
// Route IDs: Red, Blue, Brn, G, Org, P, Pexp, Pink, Y
// Station IDs: 4xxxx (parent), 3xxxx (platform-specific)
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAdapter } from "../core/BaseAdapter.js";
import { RouteLookup } from "../utils/route-lookup.js";

// CTA JSON API base URLs
const CTA_API = {
  arrivals:  "https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx",
  positions: "https://lapi.transitchicago.com/api/1.0/ttpositions.aspx",
  alerts:    "https://www.transitchicago.com/api/1.0/alerts.aspx",
};

// All CTA rail route codes
const ROUTE_CODES = ["Red", "Blue", "Brn", "G", "Org", "P", "Pink", "Y"];

// Key stations to poll arrivals for (major transfer points + terminals)
const KEY_STATIONS = [
  "40380", // Clark/Lake (Blue/Brown/Green/Orange/Purple/Pink — the big one)
  "41320", // Belmont (Red/Brown/Purple)
  "41220", // Fullerton (Red/Brown/Purple)
  "41400", // Roosevelt (Red/Orange/Green)
  "40900", // Howard (Red/Purple/Yellow)
  "40710", // Chicago (Brown/Purple)
  "40560", // Jackson (Red)
  "40070", // Jackson (Blue)
  "40890", // O'Hare (Blue)
  "40930", // Midway (Orange)
  "40450", // 95th/Dan Ryan (Red)
  "41290", // Kimball (Brown)
  "40260", // State/Lake (Loop)
  "40680", // Adams/Wabash (Loop)
  "40850", // Harold Washington Library (Loop)
  "41160", // Clinton (Green/Pink)
];

export default class CtaAdapter extends BaseAdapter {
  static adapterId = "cta";

  constructor(config, deps) {
    super(config, deps);
    this.lookup = new RouteLookup();
    this._jsonTimers = [];
    this._apiKey = process.env.CTA_API_KEY || "";
  }

  async onStart() {
    this.logger.info("Loading CTA static GTFS data...");
    try {
      await this.lookup.loadFromDb(this.pg, this.id);
      this.logger.info(`  Loaded ${this.lookup.routeCount} routes, ${this.lookup.stopCount} stops`);
    } catch (err) {
      this.logger.warn({ err }, "Could not load from DB — using built-in route data");
    }

    if (!this._apiKey) {
      this.logger.warn("CTA_API_KEY not set — Train Tracker API will not work");
      return;
    }

    this._startJsonPolling();
  }

  async onStop() {
    this._jsonTimers.forEach(clearInterval);
    this._jsonTimers = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  JSON API POLLING
  // ═══════════════════════════════════════════════════════════════════════════

  _startJsonPolling() {
    // Arrivals for key stations — every 30s
    this._pollJson("arrivals", () => this._fetchArrivals(), 30_000);

    // Train positions for all routes — every 30s
    this._pollJson("positions", () => this._fetchPositions(), 30_000);

    // Customer alerts — every 60s
    this._pollJson("alerts", () => this._fetchAlerts(), 60_000);
  }

  _pollJson(name, fn, intervalMs) {
    fn().catch((err) => this.logger.error({ err: err.message }, `CTA JSON ${name} error`));
    const timer = setInterval(() => {
      fn().catch((err) => this.logger.error({ err: err.message }, `CTA JSON ${name} error`));
    }, intervalMs);
    this._jsonTimers.push(timer);
    this.logger.info(`  → ${name} (Train Tracker API) every ${intervalMs / 1000}s`);
  }

  // ─── Arrivals: station departure boards ────────────────────────────────

  async _fetchArrivals() {
    const pipeline = this.redis.pipeline();
    const ttl = 45;
    let totalPredictions = 0;

    // Poll each key station
    for (const stationId of KEY_STATIONS) {
      try {
        const url = `${CTA_API.arrivals}?key=${this._apiKey}&mapid=${stationId}&max=15&outputType=JSON`;
        const data = await this._jsonGet(url);

        const etas = data?.ctatt?.eta;
        if (!Array.isArray(etas)) continue;

        const departures = etas.map((eta, idx) => {
          const routeInfo = this._resolveRoute(eta.rt);
          const arrivalTime = this._parseCtaTime(eta.arrT);
          const predTime = this._parseCtaTime(eta.prdt);

          return {
            tripId: `cta-${eta.rn}-${idx}`,
            routeId: eta.rt,
            routeName: routeInfo.name,
            routeColor: routeInfo.color,
            routeType: "rail",
            stopId: eta.staId,
            stopName: eta.staNm || "",
            direction: eta.destNm || "",
            departureTime: arrivalTime,
            delay: eta.isDly === "1" ? 300 : null, // CTA only flags delayed yes/no, estimate 5min
            isRealtime: eta.isSch !== "1",
            // CTA-specific extras
            _platformDesc: eta.stpDe || "",
            _isApproaching: eta.isApp === "1",
            _isScheduled: eta.isSch === "1",
            _isDelayed: eta.isDly === "1",
            _runNumber: eta.rn,
            _lat: eta.lat ? parseFloat(eta.lat) : null,
            _lon: eta.lon ? parseFloat(eta.lon) : null,
          };
        });

        if (departures.length > 0) {
          departures.sort((a, b) => (a.departureTime || Infinity) - (b.departureTime || Infinity));
          pipeline.setex(`departures:${this.id}:${stationId}`, ttl, JSON.stringify(departures));
          totalPredictions += departures.length;

          // Also key by station name (lowercase, spaces to underscores) for search
          const nameKey = (etas[0]?.staNm || "").toLowerCase().replace(/[^a-z0-9]/g, "_");
          if (nameKey) {
            pipeline.setex(`departures:${this.id}:station:${nameKey}`, ttl, JSON.stringify(departures));
          }
        }
      } catch (err) {
        this.logger.debug({ stationId, err: err.message }, `Arrivals failed for station ${stationId}`);
      }
    }

    pipeline.setex(`arrivals:${this.id}:_summary`, ttl,
      JSON.stringify({ predictions: totalPredictions, stations: KEY_STATIONS.length, updatedAt: Date.now() })
    );
    await pipeline.exec();
    this.logger.debug(`Arrivals: ${totalPredictions} predictions from ${KEY_STATIONS.length} stations`);
  }

  // ─── Positions: live train locations ───────────────────────────────────

  async _fetchPositions() {
    const pipeline = this.redis.pipeline();
    const ttl = 45;
    let totalTrains = 0;

    // Request all routes at once (up to 8 per request)
    const routeParam = ROUTE_CODES.join(",");
    try {
      const url = `${CTA_API.positions}?key=${this._apiKey}&rt=${routeParam}&outputType=JSON`;
      const data = await this._jsonGet(url);

      const routes = data?.ctatt?.route;
      if (!Array.isArray(routes)) return;

      for (const routeObj of routes) {
        const routeCode = routeObj["@name"];
        const trains = routeObj.train;
        if (!Array.isArray(trains)) continue;

        const routeInfo = this._resolveRoute(routeCode);

        const vehicles = trains.map((train) => ({
          vehicleId: String(train.rn || ""),
          tripId: `cta-${train.rn}`,
          routeId: routeCode,
          routeName: routeInfo.name,
          lat: train.lat ? parseFloat(train.lat) : 0,
          lng: train.lon ? parseFloat(train.lon) : 0,
          bearing: train.heading ? parseFloat(train.heading) : null,
          speed: null,
          stopId: train.nextStaId || null,
          status: train.isApp === "1" ? "INCOMING" : train.isDly === "1" ? "STOPPED" : "IN_TRANSIT",
          timestamp: Date.now() / 1000,
          _nextStationName: train.nextStaNm || "",
          _destination: train.destNm || "",
        })).filter((v) => v.lat !== 0 && v.lng !== 0);

        if (vehicles.length > 0) {
          pipeline.setex(`vehicles:${this.id}:${routeCode}`, ttl, JSON.stringify(vehicles));
          totalTrains += vehicles.length;
        }
      }
    } catch (err) {
      this.logger.error({ err: err.message }, "Positions fetch failed");
    }

    pipeline.setex(`positions:${this.id}:_summary`, ttl,
      JSON.stringify({ trains: totalTrains, updatedAt: Date.now() })
    );
    await pipeline.exec();
    this.logger.debug(`Positions: ${totalTrains} trains across ${ROUTE_CODES.length} routes`);
  }

  // ─── Alerts: customer alerts ───────────────────────────────────────────

  async _fetchAlerts() {
    try {
      const url = `${CTA_API.alerts}?outputType=JSON&activeonly=true`;
      const data = await this._jsonGet(url);

      const ctaAlerts = data?.CTAAlerts?.Alert;
      if (!Array.isArray(ctaAlerts)) {
        // Might be single alert as object
        const arr = ctaAlerts ? [ctaAlerts] : [];
        if (arr.length === 0) return;
      }

      const alertList = Array.isArray(ctaAlerts) ? ctaAlerts : [ctaAlerts];

      const alerts = alertList.map((alert, i) => {
        // Extract affected route(s)
        const services = alert.ImpactedService?.Service;
        const serviceList = Array.isArray(services) ? services : services ? [services] : [];
        const routeIds = serviceList
          .filter((s) => s.ServiceType === "R") // R = rail
          .map((s) => s.ServiceId || "")
          .filter(Boolean);

        const routeNames = routeIds.map((r) => this._resolveRoute(r).name);

        return {
          alertId: alert.AlertId || `cta-alert-${i}`,
          routeIds,
          routeNames,
          stopIds: [],
          severity: this._mapAlertSeverity(alert),
          type: this._mapAlertType(alert),
          headerText: alert.Headline || "",
          descriptionText: alert.ShortDescription || alert.FullDescription?.["#cdata-section"] || "",
          activePeriods: [{
            start: alert.EventStart ? new Date(alert.EventStart).getTime() / 1000 : Date.now() / 1000,
            end: alert.EventEnd ? new Date(alert.EventEnd).getTime() / 1000 : null,
          }],
          updatedAt: Date.now() / 1000,
          _ttImpact: alert.ttim === "1", // Train Tracker prediction quality affected
        };
      }).filter((a) => a.routeIds.length > 0 || a.headerText); // keep alerts with content

      const pipeline = this.redis.pipeline();
      pipeline.setex(`alerts:${this.id}`, 120, JSON.stringify(alerts));
      await pipeline.exec();
      this.logger.debug(`Alerts: ${alerts.length} active`);

    } catch (err) {
      this.logger.error({ err: err.message }, "Alerts fetch failed");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GTFS-RT FALLBACK (BaseAdapter still calls these, but we return empty)
  // ═══════════════════════════════════════════════════════════════════════════

  async parseFeed(feedType, buffer) {
    // CTA doesn't have GTFS-RT feeds — this should never be called with valid data
    // But if it is, try to decode anyway
    const { decodeFeed, extractTripUpdates, extractVehiclePositions, extractAlerts } = await import("../utils/protobuf.js");
    const feed = await decodeFeed(buffer);
    switch (feedType) {
      case "tripUpdates": return extractTripUpdates(feed);
      case "vehiclePositions": return extractVehiclePositions(feed);
      case "alerts": return extractAlerts(feed);
      default: return [];
    }
  }

  normalize(feedType, entities) {
    // Minimal normalization for any GTFS-RT data that might come through
    return [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  async _jsonGet(url) {
    const resp = await this.fetcher.fetchFeed(url, { type: "none" });
    return JSON.parse(resp.toString("utf-8"));
  }

  /**
   * Parse CTA datetime format: "2015-04-30T20:23:53" (Chicago local time)
   * Returns Unix timestamp
   */
  _parseCtaTime(timeStr) {
    if (!timeStr) return null;
    try {
      // CTA times are in Chicago timezone (America/Chicago)
      // Append timezone offset for correct parsing
      const date = new Date(timeStr + "-05:00"); // CDT = UTC-5 (summer), CST = UTC-6 (winter)
      // More robust: detect DST
      const now = new Date();
      const jan = new Date(now.getFullYear(), 0, 1);
      const jul = new Date(now.getFullYear(), 6, 1);
      const isDST = now.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
      const offset = isDST ? "-05:00" : "-06:00";
      const corrected = new Date(timeStr + offset);
      return Math.floor(corrected.getTime() / 1000);
    } catch {
      return null;
    }
  }

  _resolveRoute(routeCode) {
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
    return routes[routeCode] || { name: routeCode || "?", color: "#888888" };
  }

  _mapAlertSeverity(alert) {
    const impact = (alert.Impact || "").toLowerCase();
    if (impact.includes("suspend") || impact.includes("no service")) return "severe";
    if (impact.includes("significant") || impact.includes("delay")) return "moderate";
    return "info";
  }

  _mapAlertType(alert) {
    const impact = (alert.Impact || "").toLowerCase();
    if (impact.includes("suspend")) return "suspended";
    if (impact.includes("delay")) return "delay";
    if (impact.includes("reroute") || impact.includes("shuttle")) return "reroute";
    if (impact.includes("planned")) return "planned_work";
    return "other";
  }
}
