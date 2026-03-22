// connext-ingestion/src/utils/route-lookup.js
// ─────────────────────────────────────────────────────────────────────────────
// Provides fast in-memory lookups for static GTFS data (routes, stops, trips).
// Each adapter can load its system's data from PostgreSQL on startup.
// ─────────────────────────────────────────────────────────────────────────────

export class RouteLookup {
  constructor() {
    this.routes = new Map();   // route_id -> { name, color, type, ... }
    this.stops = new Map();    // stop_id -> { name, lat, lng, ... }
    this.trips = new Map();    // trip_id -> { route_id, direction_id, headsign, ... }
  }

  /**
   * Load static GTFS data for a system from PostgreSQL
   * @param {object} pg - PostgreSQL client
   * @param {string} systemId
   */
  async loadFromDb(pg, systemId) {
    // Load routes
    const routeRes = await pg.query(
      `SELECT route_id, route_short_name, route_long_name, route_color, route_type
       FROM gtfs_routes WHERE system_id = $1`,
      [systemId]
    );
    for (const row of routeRes.rows) {
      this.routes.set(row.route_id, {
        id: row.route_id,
        name: row.route_short_name || row.route_long_name,
        longName: row.route_long_name,
        color: row.route_color ? `#${row.route_color}` : "#888888",
        type: row.route_type,
      });
    }

    // Load stops
    const stopRes = await pg.query(
      `SELECT stop_id, stop_name, stop_lat, stop_lon
       FROM gtfs_stops WHERE system_id = $1`,
      [systemId]
    );
    for (const row of stopRes.rows) {
      this.stops.set(row.stop_id, {
        id: row.stop_id,
        name: row.stop_name,
        lat: parseFloat(row.stop_lat),
        lng: parseFloat(row.stop_lon),
      });
    }

    // Load trips (can be large — only load active service dates if needed)
    const tripRes = await pg.query(
      `SELECT trip_id, route_id, direction_id, trip_headsign
       FROM gtfs_trips WHERE system_id = $1`,
      [systemId]
    );
    for (const row of tripRes.rows) {
      this.trips.set(row.trip_id, {
        tripId: row.trip_id,
        routeId: row.route_id,
        directionId: row.direction_id,
        headsign: row.trip_headsign,
      });
    }
  }

  /**
   * Load from a plain object (for testing or systems without PG)
   */
  loadFromObject({ routes = [], stops = [], trips = [] }) {
    for (const r of routes) this.routes.set(r.id, r);
    for (const s of stops) this.stops.set(s.id, s);
    for (const t of trips) this.trips.set(t.tripId, t);
  }

  getRoute(routeId) { return this.routes.get(routeId) || null; }
  getStop(stopId) { return this.stops.get(stopId) || null; }
  getTrip(tripId) { return this.trips.get(tripId) || null; }
  

  getStopByName(name) {
    for (const [id, stop] of this._stops) {
      if (stop.name && stop.name.toLowerCase() === name.toLowerCase()) {
        return { id, ...stop };
      }
    }
    return null;
  }

  /**
   * Resolve a trip to its route info. Returns route data or a fallback.
   */
  resolveTrip(tripId) {
    const trip = this.trips.get(tripId);
    if (!trip) return { routeId: null, routeName: "?", routeColor: "#888888", routeType: "other", direction: "" };
    const route = this.routes.get(trip.routeId);
    return {
      routeId: trip.routeId,
      routeName: route?.name || trip.routeId,
      routeColor: route?.color || "#888888",
      routeType: route?.type ?? "other",
      direction: trip.headsign || (trip.directionId === 0 ? "Outbound" : "Inbound"),
    };
  }

  get routeCount() { return this.routes.size; }
  get stopCount() { return this.stops.size; }
  get tripCount() { return this.trips.size; }
}
