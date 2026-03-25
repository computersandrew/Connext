// packages/ingestion/src/adapters/cdta.js
// ─────────────────────────────────────────────────────────────────────────────
// CDTA (Capital District Transportation Authority — Albany/Troy)
//
// Static schedule only — CDTA does not publish GTFS-RT feeds.
// Route planning works via the route graph built from stop_times.
// No live departures or vehicle positions.
// ─────────────────────────────────────────────────────────────────────────────

import { BaseAdapter } from "../core/BaseAdapter.js";
import { RouteLookup } from "../utils/route-lookup.js";

export default class CdtaAdapter extends BaseAdapter {
  static adapterId = "cdta";

  constructor(config, deps) {
    super(config, deps);
    this.lookup = new RouteLookup();
  }

  async onStart() {
    this.logger.info("Loading CDTA static GTFS data...");
    try {
      await this.lookup.loadFromDb(this.pg, this.id);
      this.logger.info(`  Loaded ${this.lookup.routeCount} routes, ${this.lookup.stopCount} stops`);
    } catch (err) {
      this.logger.warn({ err }, "Could not load from DB");
    }

    // Write a basic health key so the API knows CDTA is active
    const pipeline = this.redis.pipeline();
    pipeline.setex(`health:${this.id}`, 300, JSON.stringify({
      status: "static_only",
      message: "CDTA runs on static schedule data — no real-time feeds available",
      routes: this.lookup.routeCount,
      stops: this.lookup.stopCount,
      updatedAt: Date.now(),
    }));
    await pipeline.exec();
  }

  // No GTFS-RT feeds — these are never called
  async parseFeed() { return []; }
  normalize() { return []; }

  _resolveRoute(routeId) {
    const dbRoute = this.lookup.getRoute(routeId);
    if (dbRoute) return { name: dbRoute.name, color: dbRoute.color || "#123573", type: "bus" };
    return { name: routeId || "?", color: "#123573", type: "bus" };
  }
}
