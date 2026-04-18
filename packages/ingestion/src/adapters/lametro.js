// connext-ingestion/src/adapters/lametro.js
// ─────────────────────────────────────────────────────────────────────────────
// LA Metro Rail (Los Angeles County Metropolitan Transportation Authority)
//
// Data sources:
//   - Metro API v2 (JSON) — real-time vehicle positions for all rail lines
//     https://api.metro.net/agencies/lametro-rail/vehicles/
//   - Metro API v2 (JSON) — service advisories / alerts
//     https://api.metro.net/agencies/lametro/service_advisories/
//   - Static GTFS (GitLab) — stop names, route metadata, scheduled departures
//     https://gitlab.com/LACMTA/gtfs_rail/-/raw/master/gtfs_rail.zip
//
// Lines served (A/B/C/D/E/K/L/J + legacy numeric IDs):
//   A (801) Blue · B (802) Red · C (803) Green · D (804) Purple
//   E (806) Expo · K (857) Crenshaw · L (805) Gold · J (910) Silver BRT
//
// Speed is derived from consecutive position deltas (Haversine) with EMA
// smoothing — the Metro API provides a heading field but not speed.
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAdapter } from "../core/BaseAdapter.js";
import { RouteLookup } from "../utils/route-lookup.js";
import {
  decodeFeed, extractTripUpdates, extractVehiclePositions, extractAlerts,
  resolveStopTime, getTranslatedText, mapVehicleStatus,
} from "../utils/protobuf.js";

const METRO_API_BASE = "https://api.metro.net";

// Haversine distance in metres
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default class LAMetroAdapter extends BaseAdapter {
  static adapterId = "lametro";

  constructor(config, deps) {
    super(config, deps);
    this.lookup = new RouteLookup();
    this._jsonTimers = [];
    // vehicleId → { lat, lng, timestamp, speed } for speed derivation
    this._prevPositions = new Map();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  async onStart() {
    this.logger.info("Loading LA Metro static GTFS data...");
    try {
      await this.lookup.loadFromDb(this.pg, this.id);
      this.logger.info(`  Loaded ${this.lookup.routeCount} routes, ${this.lookup.stopCount} stops`);
    } catch (err) {
      this.logger.warn({ err }, "Could not load from DB — running without static GTFS enrichment");
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
    // Vehicle positions — poll every 15 s so speed estimates stay fresh
    this._pollJson("vehicles", () => this._fetchVehicles(), 15_000);
    // Service advisories — poll every 60 s
    this._pollJson("alerts", () => this._fetchAlerts(), 60_000);
  }

  _pollJson(name, fn, intervalMs) {
    fn().catch((err) => this.logger.error({ err }, `LA Metro JSON ${name} error`));
    const timer = setInterval(
      () => fn().catch((err) => this.logger.error({ err }, `LA Metro JSON ${name} error`)),
      intervalMs,
    );
    this._jsonTimers.push(timer);
    this.logger.info(`  → ${name} (JSON API) every ${intervalMs / 1000}s`);
  }

  // ─── Vehicle positions ─────────────────────────────────────────────────────

  async _fetchVehicles() {
    const resp = await this._jsonGet(`${METRO_API_BASE}/agencies/lametro-rail/vehicles/`);
    // Metro API returns { items: [...] }; handle both wrapped and bare arrays
    const items = resp?.items ?? resp?.data ?? (Array.isArray(resp) ? resp : []);
    if (!items.length) return;

    const nowSec = Date.now() / 1000;
    const vehicles = [];

    for (const v of items) {
      const vehicleId = String(v.id ?? v.vehicle_id ?? "");
      const tripId    = String(v.trip_id ?? "");
      const routeId   = String(v.route_id ?? "");
      const lat       = parseFloat(v.latitude  ?? v.lat ?? 0);
      const lng       = parseFloat(v.longitude ?? v.lon ?? v.lng ?? 0);
      if (!lat || !lng || !vehicleId) continue;

      const routeInfo = this._resolveRoute(routeId);
      const bearing   = v.heading != null ? parseFloat(v.heading) : null;

      // Derive speed (m/s) from position delta; fall back to reported speed
      let speed = v.speed != null ? parseFloat(v.speed) : null;
      if (speed === null || isNaN(speed)) {
        const prev = this._prevPositions.get(vehicleId);
        if (prev) {
          const dtSec = nowSec - prev.timestamp;
          if (dtSec > 1 && dtSec < 120) {
            const distM    = haversineMeters(prev.lat, prev.lng, lat, lng);
            const rawSpeed = distM / dtSec; // m/s
            speed = rawSpeed <= 90                          // reject >200 mph outliers
              ? (prev.speed != null ? 0.4 * rawSpeed + 0.6 * prev.speed : rawSpeed)
              : (prev.speed ?? null);
          } else {
            speed = prev.speed ?? null;
          }
        }
      }

      this._prevPositions.set(vehicleId, { lat, lng, timestamp: nowSec, speed });

      vehicles.push({
        vehicleId,
        tripId,
        routeId,
        routeName: routeInfo.name,
        lat,
        lng,
        bearing,
        speed,    // m/s (converted to mph by the app)
        stopId:   v.stop_id ?? null,
        status:   "IN_TRANSIT",
        timestamp: nowSec,
      });
    }

    if (!vehicles.length) return;

    // Write grouped by routeId so the vehicle-scan glob works correctly
    const byRoute = {};
    for (const v of vehicles) {
      (byRoute[v.routeId] ??= []).push(v);
    }
    const pipeline = this.redis.pipeline();
    const ttl = 30;
    for (const [routeId, rvs] of Object.entries(byRoute)) {
      pipeline.setex(`vehicles:${this.id}:${routeId}`, ttl, JSON.stringify(rvs));
    }
    await pipeline.exec();
    this.logger.debug(`LA Metro vehicles: ${vehicles.length} tracked`);
  }

  // ─── Service advisories ────────────────────────────────────────────────────

  async _fetchAlerts() {
    try {
      const resp = await this._jsonGet(`${METRO_API_BASE}/agencies/lametro/service_advisories/`);
      const items = resp?.items ?? resp?.data ?? (Array.isArray(resp) ? resp : []);

      const alerts = items.map((a, i) => {
        const routeIds = (a.route_ids ?? a.routes ?? []).map(String);
        return {
          alertId: `lametro-${a.id ?? i}`,
          routeIds,
          routeNames: routeIds.map((r) => this._resolveRoute(r).name),
          stopIds: [],
          severity: a.alert_type === "major" ? "severe"
                  : a.alert_type === "minor" ? "moderate"
                  : "info",
          type: "planned_work",
          headerText:      a.headline ?? a.title ?? a.subject ?? "",
          descriptionText: a.description ?? a.body ?? "",
          activePeriods:   [{ start: Date.now() / 1000, end: null }],
          updatedAt:       Date.now() / 1000,
        };
      }).filter((a) => a.headerText);

      const pipeline = this.redis.pipeline();
      pipeline.setex(`alerts:${this.id}`, 120, JSON.stringify(alerts));
      await pipeline.exec();
      this.logger.debug(`LA Metro alerts: ${alerts.length} active`);
    } catch (err) {
      this.logger.debug({ err: err.message }, "LA Metro alerts fetch skipped");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GTFS-RT FALLBACK — invoked if protobuf feed URLs are ever configured
  // ═══════════════════════════════════════════════════════════════════════════

  async parseFeed(feedType, buffer) {
    const feed = await decodeFeed(buffer);
    switch (feedType) {
      case "tripUpdates":      return extractTripUpdates(feed);
      case "vehiclePositions": return extractVehiclePositions(feed);
      case "alerts":           return extractAlerts(feed);
      default:                 return [];
    }
  }

  normalize(feedType, entities) {
    switch (feedType) {
      case "tripUpdates":      return this._normalizeTripUpdates(entities);
      case "vehiclePositions": return this._normalizeVehiclePositions(entities);
      case "alerts":           return this._normalizeAlerts(entities);
      default:                 return [];
    }
  }

  _normalizeTripUpdates(entities) {
    const departures = [];
    for (const { tripUpdate } of entities) {
      const trip = tripUpdate.trip;
      if (!trip) continue;
      const routeInfo = this._resolveRoute(trip.routeId);
      for (const stu of tripUpdate.stopTimeUpdate ?? []) {
        if (!stu.stopId) continue;
        const stop = this.lookup.getStop(stu.stopId);
        const { time: departureTime, delay } = resolveStopTime(stu.departure ?? stu.arrival);
        departures.push({
          tripId: trip.tripId, routeId: trip.routeId,
          routeName: routeInfo.name, routeColor: routeInfo.color, routeType: routeInfo.type,
          stopId: stu.stopId, stopName: stop?.name ?? stu.stopId,
          direction: trip.directionId === 0 ? "Outbound" : "Inbound",
          departureTime, delay: delay ?? null, isRealtime: true,
        });
      }
    }
    return departures;
  }

  _normalizeVehiclePositions(entities) {
    return entities.map(({ vehicle }) => {
      const trip = vehicle.trip ?? {};
      const pos  = vehicle.position ?? {};
      const routeInfo = this._resolveRoute(trip.routeId);
      return {
        vehicleId: vehicle.vehicle?.id ?? "unknown",
        tripId:    trip.tripId ?? "",
        routeId:   trip.routeId ?? "",
        routeName: routeInfo.name,
        lat: pos.latitude  ?? 0,
        lng: pos.longitude ?? 0,
        bearing: pos.bearing ?? null,
        speed:   pos.speed   ?? null,
        stopId:  vehicle.stopId ?? null,
        status:  mapVehicleStatus(vehicle.currentStatus),
        timestamp: vehicle.timestamp ? Number(vehicle.timestamp) : Date.now() / 1000,
      };
    });
  }

  _normalizeAlerts(entities) {
    return entities.map(({ id, alert }) => {
      const routeIds = [];
      const stopIds  = [];
      for (const ie of alert.informedEntity ?? []) {
        if (ie.routeId) routeIds.push(ie.routeId);
        if (ie.stopId)  stopIds.push(ie.stopId);
      }
      const uniqueRouteIds = [...new Set(routeIds)];
      return {
        alertId: id, routeIds: uniqueRouteIds,
        routeNames: uniqueRouteIds.map((r) => this._resolveRoute(r).name),
        stopIds: [...new Set(stopIds)],
        severity: "info", type: "other",
        headerText:      getTranslatedText(alert.headerText),
        descriptionText: getTranslatedText(alert.descriptionText),
        activePeriods: (alert.activePeriod ?? []).map((p) => ({
          start: p.start ? Number(p.start) : null,
          end:   p.end   ? Number(p.end)   : null,
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

  _resolveRoute(routeId) {
    // LA Metro uses both legacy numeric IDs (801–910) and letter IDs (A–L)
    const routes = {
      // Numeric (legacy GTFS)
      "801": { name: "A Line", color: "#2160AA", type: "light_rail" }, // Blue
      "802": { name: "B Line", color: "#EF3340", type: "subway"     }, // Red
      "803": { name: "C Line", color: "#00A550", type: "light_rail" }, // Green
      "804": { name: "D Line", color: "#6A2277", type: "subway"     }, // Purple
      "805": { name: "L Line", color: "#F5B623", type: "light_rail" }, // Gold
      "806": { name: "E Line", color: "#2160AA", type: "light_rail" }, // Expo (same blue as A)
      "857": { name: "K Line", color: "#E16FBD", type: "light_rail" }, // Crenshaw
      "910": { name: "J Line", color: "#A7A9AC", type: "bus"        }, // Silver BRT
      // Letter (newer GTFS format)
      "A":   { name: "A Line", color: "#2160AA", type: "light_rail" },
      "B":   { name: "B Line", color: "#EF3340", type: "subway"     },
      "C":   { name: "C Line", color: "#00A550", type: "light_rail" },
      "D":   { name: "D Line", color: "#6A2277", type: "subway"     },
      "E":   { name: "E Line", color: "#2160AA", type: "light_rail" },
      "K":   { name: "K Line", color: "#E16FBD", type: "light_rail" },
      "L":   { name: "L Line", color: "#F5B623", type: "light_rail" },
      "J":   { name: "J Line", color: "#A7A9AC", type: "bus"        },
    };
    if (routes[routeId]) return routes[routeId];
    const dbRoute = this.lookup.getRoute(routeId);
    if (dbRoute) return { name: dbRoute.name, color: dbRoute.color, type: dbRoute.type ?? "other" };
    return { name: routeId ?? "?", color: "#0072BC", type: "other" };
  }
}
