// connext-ingestion/src/core/BaseAdapter.js
// ─────────────────────────────────────────────────────────────────────────────
// BASE ADAPTER
// Every transit system adapter extends this class. It enforces a consistent
// interface while allowing each system to handle its quirks internally.
//
// To create a new adapter:
//   1. Extend BaseAdapter
//   2. Implement the required methods (marked with "MUST OVERRIDE")
//   3. Optionally override the hook methods (marked with "MAY OVERRIDE")
// ─────────────────────────────────────────────────────────────────────────────

export class BaseAdapter {
  /**
   * @param {object} systemConfig - The system entry from config/systems.js
   * @param {object} deps - Injected dependencies { redis, pg, logger, fetcher }
   */
  constructor(systemConfig, deps) {
    this.config = systemConfig;
    this.id = systemConfig.id;
    this.name = systemConfig.name;
    this.redis = deps.redis;
    this.pg = deps.pg;
    this.logger = deps.logger.child({ system: this.id });
    this.fetcher = deps.fetcher;

    // Adapter state
    this._running = false;
    this._timers = [];
    this._stats = {
      fetchCount: 0,
      errorCount: 0,
      lastFetchAt: null,
      lastErrorAt: null,
      lastError: null,
      avgFetchMs: 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LIFECYCLE — called by the orchestrator, not overridden by adapters
  // ═══════════════════════════════════════════════════════════════════════════

  /** Start all feed polling loops for this system */
  async start() {
    if (this._running) return;
    this._running = true;
    this.logger.info(`Starting adapter for ${this.name} (${this.config.city})`);

    await this.onStart();

    const { feeds, intervals } = this.config;

    // Start a polling loop for each feed type that has URLs configured
    for (const feedType of ["tripUpdates", "vehiclePositions", "alerts"]) {
      const urls = feeds[feedType];
      if (!urls || urls.length === 0) continue;

      const intervalMs = intervals[feedType] || 30_000;

      // Fetch immediately on start, then on interval
      this._pollFeed(feedType, urls);
      const timer = setInterval(() => this._pollFeed(feedType, urls), intervalMs);
      this._timers.push(timer);

      this.logger.info(`  → ${feedType}: ${urls.length} feed(s) every ${intervalMs / 1000}s`);
    }
  }

  /** Stop all polling loops */
  async stop() {
    if (!this._running) return;
    this._running = false;
    this._timers.forEach(clearInterval);
    this._timers = [];
    await this.onStop();
    this.logger.info(`Stopped adapter for ${this.name}`);
  }

  /** Get current health/stats */
  getStats() {
    return {
      system: this.id,
      name: this.name,
      running: this._running,
      ...this._stats,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INTERNAL POLLING — handles fetch, auth, retries, error tracking
  // ═══════════════════════════════════════════════════════════════════════════

  async _pollFeed(feedType, urls) {
    const startMs = Date.now();
    try {
      // Fetch all URLs for this feed type (some systems split by line group)
      const buffers = await Promise.all(
        urls.map((url) => this.fetcher.fetchFeed(url, this.config.auth))
      );

      // Delegate parsing to the adapter's implementation
      const entities = [];
      for (const buffer of buffers) {
        const parsed = this.parseFeed(feedType, buffer);
        entities.push(...parsed);
      }

      // Transform through the adapter's normalizer
      const normalized = this.normalize(feedType, entities);

      // Write to Redis via the adapter's cache writer
      await this.writeToCache(feedType, normalized);

      // Update stats
      const elapsed = Date.now() - startMs;
      this._stats.fetchCount++;
      this._stats.lastFetchAt = new Date().toISOString();
      this._stats.avgFetchMs = Math.round(
        (this._stats.avgFetchMs * (this._stats.fetchCount - 1) + elapsed) / this._stats.fetchCount
      );

      // Hook for post-processing (historical data, disruption detection, etc.)
      await this.onFeedProcessed(feedType, normalized, elapsed);

    } catch (err) {
      const error = err || new Error("Unknown feed error");
      this._stats.errorCount++;
      this._stats.lastErrorAt = new Date().toISOString();
      this._stats.lastError = error.message || String(error);
      this.logger.error({ err: error, feedType }, `Feed error: ${feedType}`);
      this.onFeedError(feedType, error);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  MUST OVERRIDE — every adapter implements these
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Parse a raw protobuf buffer into an array of feed entities.
   * @param {string} feedType - "tripUpdates" | "vehiclePositions" | "alerts"
   * @param {Buffer} buffer - Raw protobuf bytes from the feed URL
   * @returns {Array<object>} - Parsed entities (raw GTFS-RT objects)
   */
  parseFeed(feedType, buffer) {
    throw new Error(`${this.id}: parseFeed() not implemented`);
  }

  /**
   * Normalize parsed entities into Connext's internal format.
   * This is where system-specific quirks get smoothed out.
   * @param {string} feedType
   * @param {Array<object>} entities - Output of parseFeed()
   * @returns {Array<object>} - Normalized objects (see schemas below)
   */
  normalize(feedType, entities) {
    throw new Error(`${this.id}: normalize() not implemented`);
  }

  /**
   * Write normalized data to Redis (and optionally PostgreSQL).
   * Default implementation provided — override only if you need custom keys.
   * @param {string} feedType
   * @param {Array<object>} normalized
   */
  async writeToCache(feedType, normalized) {
    const pipeline = this.redis.pipeline();
    const ttl = this.config.intervals[feedType]
      ? Math.ceil(this.config.intervals[feedType] / 1000) + 15
      : 45;

    if (feedType === "tripUpdates") {
      // Group departures by stop_id
      const byStop = {};
      for (const dep of normalized) {
        const key = `departures:${this.id}:${dep.stopId}`;
        if (!byStop[key]) byStop[key] = [];
        byStop[key].push(dep);
      }
      for (const [key, deps] of Object.entries(byStop)) {
        // Sort by predicted departure time
        deps.sort((a, b) => (a.departureTime || Infinity) - (b.departureTime || Infinity));
        pipeline.setex(key, ttl, JSON.stringify(deps));
      }
      // Also write a system-wide "all departures" summary for the home screen
      pipeline.setex(`departures:${this.id}:_summary`, ttl,
        JSON.stringify({ count: normalized.length, updatedAt: Date.now() })
      );
    }

    if (feedType === "vehiclePositions") {
      // Group by route_id
      const byRoute = {};
      for (const vp of normalized) {
        const key = `vehicles:${this.id}:${vp.routeId}`;
        if (!byRoute[key]) byRoute[key] = [];
        byRoute[key].push(vp);
      }
      for (const [key, vehicles] of Object.entries(byRoute)) {
        pipeline.setex(key, ttl, JSON.stringify(vehicles));
      }
    }

    if (feedType === "alerts") {
      // Store all alerts as a single key per system
      pipeline.setex(`alerts:${this.id}`, ttl * 2, JSON.stringify(normalized));
    }

    await pipeline.exec();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  MAY OVERRIDE — hooks for custom behavior
  // ═══════════════════════════════════════════════════════════════════════════

  /** Called once when the adapter starts, before polling begins */
  async onStart() {}

  /** Called when the adapter stops */
  async onStop() {}

  /** Called after each successful feed processing cycle */
  async onFeedProcessed(feedType, normalized, elapsedMs) {}

  /** Called when a feed fetch/parse fails */
  onFeedError(feedType, error) {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  NORMALIZED SCHEMAS — what adapters must produce
// ═══════════════════════════════════════════════════════════════════════════
//
//  TripUpdate (departure):
//  {
//    tripId:        string,       // GTFS trip_id
//    routeId:       string,       // GTFS route_id
//    routeName:     string,       // Human-readable ("A", "Red Line", "Broad St")
//    routeColor:    string,       // Hex color "#0039A6"
//    routeType:     string,       // "subway" | "rail" | "bus" | "light_rail" | "trolley" | "ferry"
//    stopId:        string,       // GTFS stop_id
//    stopName:      string,       // Human-readable station name
//    direction:     string,       // "Uptown" | "Downtown" | "Inbound" | "Outbound" | headsign
//    departureTime: number,       // Unix timestamp (predicted or scheduled)
//    delay:         number|null,  // Seconds of delay (positive = late, null = on time)
//    isRealtime:    boolean,      // true if from RT feed, false if schedule fallback
//  }
//
//  VehiclePosition:
//  {
//    vehicleId:     string,
//    tripId:        string,
//    routeId:       string,
//    routeName:     string,
//    lat:           number,
//    lng:           number,
//    bearing:       number|null,
//    speed:         number|null,  // m/s
//    stopId:        string|null,  // current or next stop
//    status:        string,       // "IN_TRANSIT" | "STOPPED" | "INCOMING"
//    timestamp:     number,       // Unix timestamp
//  }
//
//  Alert:
//  {
//    alertId:       string,
//    routeIds:      string[],     // affected routes
//    routeNames:    string[],     // human-readable
//    stopIds:       string[],     // affected stops (may be empty)
//    severity:      string,       // "info" | "moderate" | "severe"
//    type:          string,       // "delay" | "suspended" | "reroute" | "planned_work" | "other"
//    headerText:    string,       // short summary
//    descriptionText: string,     // full description
//    activePeriods: Array<{start: number, end: number|null}>,
//    updatedAt:     number,       // Unix timestamp
//  }
