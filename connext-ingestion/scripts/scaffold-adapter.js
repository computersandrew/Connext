#!/usr/bin/env node
// connext-ingestion/scripts/scaffold-adapter.js
// ─────────────────────────────────────────────────────────────────────────────
// USAGE: npm run add-system -- --id wmata --name "WMATA" --city "Washington DC"
//
// Generates:
//   1. src/adapters/{id}.js  — adapter file from template
//   2. Prints the config entry to paste into config/systems.js
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "src", "adapters");

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const id = getArg("id");
const name = getArg("name");
const city = getArg("city");

if (!id || !name || !city) {
  console.error("Usage: npm run add-system -- --id <id> --name <name> --city <city>");
  console.error("Example: npm run add-system -- --id wmata --name WMATA --city \"Washington DC\"");
  process.exit(1);
}

const className = name.replace(/[^a-zA-Z0-9]/g, "") + "Adapter";
const filePath = join(ADAPTERS_DIR, `${id}.js`);

if (existsSync(filePath)) {
  console.error(`Adapter file already exists: ${filePath}`);
  process.exit(1);
}

const template = `// connext-ingestion/src/adapters/${id}.js
// ─────────────────────────────────────────────────────────────────────────────
// ${name} (${city}) Adapter
//
// TODO: Document system-specific quirks here
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAdapter } from "../core/BaseAdapter.js";
import { RouteLookup } from "../utils/route-lookup.js";
import {
  decodeFeed, extractTripUpdates, extractVehiclePositions, extractAlerts,
  resolveStopTime, getTranslatedText, mapVehicleStatus,
} from "../utils/protobuf.js";

export default class ${className} extends BaseAdapter {
  static adapterId = "${id}";

  constructor(config, deps) {
    super(config, deps);
    this.lookup = new RouteLookup();
  }

  async onStart() {
    this.logger.info("Loading ${name} static GTFS data...");
    try {
      await this.lookup.loadFromDb(this.pg, this.id);
      this.logger.info(\`  Loaded \${this.lookup.routeCount} routes, \${this.lookup.stopCount} stops\`);
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

  // ─── TODO: Implement these ──────────────────────────────────────────────

  _normalizeTripUpdates(entities) {
    const departures = [];

    for (const { tripUpdate } of entities) {
      const trip = tripUpdate.trip;
      if (!trip) continue;

      for (const stu of tripUpdate.stopTimeUpdate || []) {
        if (!stu.stopId) continue;
        const stop = this.lookup.getStop(stu.stopId);
        const routeInfo = this._resolveRoute(trip.routeId);
        const { time: departureTime, delay } = resolveStopTime(stu.departure || stu.arrival);

        departures.push({
          tripId: trip.tripId,
          routeId: trip.routeId,
          routeName: routeInfo.name,
          routeColor: routeInfo.color,
          routeType: routeInfo.type,
          stopId: stu.stopId,
          stopName: stop?.name || stu.stopId,
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
        severity: "info",
        type: "other",
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

  // ─── TODO: Fill in route mapping for ${name} ───────────────────────────

  _resolveRoute(routeId) {
    // TODO: Add route ID → { name, color, type } mapping
    const dbRoute = this.lookup.getRoute(routeId);
    if (dbRoute) return { name: dbRoute.name, color: dbRoute.color, type: dbRoute.type || "other" };
    return { name: routeId || "?", color: "#888888", type: "other" };
  }
}
`;

writeFileSync(filePath, template);
console.log(`\n✅ Created adapter: ${filePath}\n`);

console.log(`📋 Add this entry to config/systems.js:\n`);
console.log(`  ${id}: {
    id: "${id}",
    name: "${name}",
    city: "${city}",
    region: { lat: 0, lng: 0, radiusKm: 30 },  // TODO: set coordinates
    enabled: true,
    adapter: "${id}",
    feeds: {
      tripUpdates: ["TODO_FEED_URL"],
      vehiclePositions: ["TODO_FEED_URL"],
      alerts: ["TODO_FEED_URL"],
    },
    auth: {
      type: "none",  // or "header" / "query"
    },
    intervals: {
      tripUpdates: 30_000,
      vehiclePositions: 30_000,
      alerts: 60_000,
    },
    staticGtfs: {
      url: "TODO_STATIC_GTFS_URL",
      refreshDays: 14,
    },
  },\n`);

console.log(`Next steps:
  1. Edit src/adapters/${id}.js — fill in _resolveRoute() with line colors
  2. Add the config entry above to config/systems.js
  3. Set any API key env vars
  4. Run: npm run validate
  5. Run: npm start
`);
