// packages/ingestion/src/core/TransferEngine.js
// ─────────────────────────────────────────────────────────────────────────────
// TRANSFER ENGINE
//
// Models platform-level transfers between routes at stations.
// Combines GTFS transfers.txt data with manual overrides for known layouts.
//
// Transfer types:
//   SAME_PLATFORM      — Cross-platform, ~0 min (e.g. express/local same track)
//   SAME_STATION        — Different platform, stairs/elevator (1-4 min)
//   STATION_COMPLEX     — Underground walkway between stations (3-8 min)
//   STREET_WALK         — Exit and walk to a nearby station (5-15 min)
//
// Each transfer has:
//   - Fixed time (for display: "~3 min transfer")
//   - Distribution (for probability engine: mean=180s, stddev=45s)
//   - Accessibility info (stairs, elevator, escalator)
// ─────────────────────────────────────────────────────────────────────────────

export const TransferType = {
  SAME_PLATFORM: "same_platform",
  SAME_STATION: "same_station",
  STATION_COMPLEX: "station_complex",
  STREET_WALK: "street_walk",
  UNKNOWN: "unknown",
};

// ─── Transfer record structure ───────────────────────────────────────────────
//
// {
//   fromStopId:    string,
//   toStopId:      string,
//   fromRouteId:   string | null,   // null = any route at this stop
//   toRouteId:     string | null,
//   type:          TransferType,
//   fixedTimeSec:  number,          // for display ("~3 min")
//   distribution:  { mean: number, stddev: number },  // seconds, for probability
//   accessibility: {
//     stairs:     boolean,
//     elevator:   boolean,
//     escalator:  boolean,
//     level:      boolean,          // wheelchair accessible / level boarding
//   },
//   notes:         string | null,   // "Long underground tunnel" etc.
//   source:        "gtfs" | "manual" | "inferred",
// }

export class TransferEngine {
  constructor(logger) {
    this.logger = logger?.child({ component: "transfers" }) || console;
    this.transfers = new Map();   // "fromStop:toStop" -> Transfer[]
    this.stationGroups = new Map(); // parent_station -> Set<stop_id>
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DATA LOADING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Load transfers from GTFS transfers.txt data (from PostgreSQL)
   */
  async loadFromGtfs(pg, systemId) {
    try {
      // Load transfers.txt data
      const transferRes = await pg.query(
        `SELECT from_stop_id, to_stop_id, transfer_type, min_transfer_time
         FROM gtfs_transfers WHERE system_id = $1`,
        [systemId]
      );

      for (const row of transferRes.rows) {
        const transfer = this._gtfsToTransfer(row);
        this._addTransfer(transfer);
      }

      // Load parent station groupings from stops.txt
      const stopRes = await pg.query(
        `SELECT stop_id, parent_station FROM gtfs_stops
         WHERE system_id = $1 AND parent_station IS NOT NULL AND parent_station != ''`,
        [systemId]
      );

      for (const row of stopRes.rows) {
        if (!this.stationGroups.has(row.parent_station)) {
          this.stationGroups.set(row.parent_station, new Set());
        }
        this.stationGroups.get(row.parent_station).add(row.stop_id);
      }

      this.logger.info(`Loaded ${this.transfers.size} GTFS transfers, ${this.stationGroups.size} station groups for ${systemId}`);
    } catch (err) {
      this.logger.warn({ err }, `Could not load GTFS transfers for ${systemId}`);
    }
  }

  /**
   * Load manual override transfers. These take priority over GTFS data.
   * @param {Array<object>} overrides - Array of transfer objects
   */
  loadManualOverrides(overrides) {
    let count = 0;
    for (const override of overrides) {
      const transfer = {
        ...override,
        source: "manual",
        distribution: override.distribution || this._inferDistribution(override.type, override.fixedTimeSec),
        accessibility: override.accessibility || { stairs: false, elevator: false, escalator: false, level: false },
      };
      this._addTransfer(transfer, true); // priority = true overwrites GTFS
      count++;
    }
    this.logger.info(`Loaded ${count} manual transfer overrides`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  QUERY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get transfer info between two stops, optionally filtered by route.
   * Returns the best (most specific) match.
   *
   * @param {string} fromStopId
   * @param {string} toStopId
   * @param {string|null} fromRouteId
   * @param {string|null} toRouteId
   * @returns {object|null} - Transfer record or null if no transfer known
   */
  getTransfer(fromStopId, toStopId, fromRouteId = null, toRouteId = null) {
    const key = this._key(fromStopId, toStopId);
    const transfers = this.transfers.get(key);
    if (!transfers || transfers.length === 0) {
      // Check if they share a parent station (inferred same-station transfer)
      return this._inferTransfer(fromStopId, toStopId);
    }

    // Find the most specific match
    // Priority: manual > gtfs > inferred
    // Then: route-specific > any-route
    let best = null;
    let bestScore = -1;

    for (const t of transfers) {
      let score = 0;
      if (t.source === "manual") score += 100;
      if (t.source === "gtfs") score += 50;
      if (t.fromRouteId && t.fromRouteId === fromRouteId) score += 10;
      if (t.toRouteId && t.toRouteId === toRouteId) score += 10;
      if (!t.fromRouteId) score += 1; // generic match
      if (!t.toRouteId) score += 1;

      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }

    return best;
  }

  /**
   * Get all transfers FROM a stop (outbound transfers)
   */
  getTransfersFrom(fromStopId) {
    const results = [];
    for (const [key, transfers] of this.transfers) {
      if (key.startsWith(fromStopId + ":")) {
        results.push(...transfers);
      }
    }
    return results;
  }

  /**
   * Calculate the probability of making a connection given available buffer time
   *
   * @param {string} fromStopId
   * @param {string} toStopId
   * @param {number} bufferTimeSec - Available time for the transfer
   * @param {object} options - { fromRouteId, toRouteId, rushHour, walkingPace }
   * @returns {{ probability: number, transferTime: number, type: string, notes: string|null }}
   */
  calculateConnectionProbability(fromStopId, toStopId, bufferTimeSec, options = {}) {
    const transfer = this.getTransfer(
      fromStopId, toStopId,
      options.fromRouteId || null,
      options.toRouteId || null
    );

    if (!transfer) {
      // No transfer data — use conservative default
      return {
        probability: this._defaultProbability(bufferTimeSec),
        transferTime: 180, // assume 3 min
        type: TransferType.UNKNOWN,
        notes: "No transfer data available — using estimate",
      };
    }

    // Adjust distribution for conditions
    let { mean, stddev } = transfer.distribution;

    // Rush hour adds variance and slight time increase
    if (options.rushHour) {
      mean *= 1.15;
      stddev *= 1.3;
    }

    // Walking pace adjustment
    if (options.walkingPace === "slow") {
      mean *= 1.3;
      stddev *= 1.1;
    } else if (options.walkingPace === "fast") {
      mean *= 0.8;
      stddev *= 0.9;
    }

    // Probability = P(transfer_time <= buffer_time)
    // Using normal CDF approximation
    const probability = this._normalCDF(bufferTimeSec, mean, stddev);

    return {
      probability: Math.max(0.01, Math.min(0.99, probability)),
      transferTime: Math.round(mean),
      type: transfer.type,
      accessibility: transfer.accessibility,
      notes: transfer.notes,
      source: transfer.source,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INTERNAL
  // ═══════════════════════════════════════════════════════════════════════════

  _key(fromStopId, toStopId) {
    return `${fromStopId}:${toStopId}`;
  }

  _addTransfer(transfer, priority = false) {
    const key = this._key(transfer.fromStopId, transfer.toStopId);
    if (!this.transfers.has(key)) {
      this.transfers.set(key, []);
    }

    if (priority) {
      // Manual overrides go to the front
      this.transfers.get(key).unshift(transfer);
    } else {
      this.transfers.get(key).push(transfer);
    }
  }

  _gtfsToTransfer(row) {
    // GTFS transfer_type:
    //   0 = recommended transfer point
    //   1 = timed transfer (vehicle waits)
    //   2 = minimum time required
    //   3 = transfer not possible
    const minTime = row.min_transfer_time ? parseInt(row.min_transfer_time) : null;
    const gtfsType = parseInt(row.transfer_type || "0");

    let type = TransferType.SAME_STATION;
    let fixedTimeSec = minTime || 120;

    if (gtfsType === 3) {
      // Not possible — encode as very high time
      type = TransferType.STREET_WALK;
      fixedTimeSec = 9999;
    } else if (gtfsType === 1) {
      // Timed transfer — vehicle waits, so very reliable
      type = TransferType.SAME_PLATFORM;
      fixedTimeSec = minTime || 60;
    } else if (minTime && minTime <= 60) {
      type = TransferType.SAME_PLATFORM;
    } else if (minTime && minTime <= 240) {
      type = TransferType.SAME_STATION;
    } else if (minTime && minTime <= 480) {
      type = TransferType.STATION_COMPLEX;
    } else if (minTime && minTime > 480) {
      type = TransferType.STREET_WALK;
    }

    return {
      fromStopId: row.from_stop_id,
      toStopId: row.to_stop_id,
      fromRouteId: null,
      toRouteId: null,
      type,
      fixedTimeSec,
      distribution: this._inferDistribution(type, fixedTimeSec),
      accessibility: { stairs: false, elevator: false, escalator: false, level: false },
      notes: null,
      source: "gtfs",
    };
  }

  /**
   * Infer a transfer when two stops share a parent station
   */
  _inferTransfer(fromStopId, toStopId) {
    // Check if both stops share a parent station
    for (const [parent, children] of this.stationGroups) {
      const fromMatch = children.has(fromStopId) || parent === fromStopId;
      const toMatch = children.has(toStopId) || parent === toStopId;

      if (fromMatch && toMatch) {
        // Same station complex — infer same_station transfer
        return {
          fromStopId,
          toStopId,
          fromRouteId: null,
          toRouteId: null,
          type: TransferType.SAME_STATION,
          fixedTimeSec: 120,
          distribution: this._inferDistribution(TransferType.SAME_STATION, 120),
          accessibility: { stairs: true, elevator: false, escalator: false, level: false },
          notes: "Inferred from shared parent station",
          source: "inferred",
        };
      }
    }

    return null;
  }

  /**
   * Infer a time distribution from transfer type and fixed time
   * Returns { mean, stddev } in seconds
   */
  _inferDistribution(type, fixedTimeSec) {
    // The stddev represents how much variance there is in transfer time.
    // Same platform = very consistent. Street walk = highly variable.
    const varianceRatios = {
      [TransferType.SAME_PLATFORM]:   0.15,  // 15% variance
      [TransferType.SAME_STATION]:    0.25,  // 25% variance
      [TransferType.STATION_COMPLEX]: 0.30,  // 30% variance
      [TransferType.STREET_WALK]:     0.35,  // 35% variance
      [TransferType.UNKNOWN]:         0.40,  // 40% variance
    };

    const ratio = varianceRatios[type] || 0.30;
    return {
      mean: fixedTimeSec,
      stddev: Math.max(10, Math.round(fixedTimeSec * ratio)),
    };
  }

  /**
   * Default probability when no transfer data exists
   */
  _defaultProbability(bufferTimeSec) {
    // Conservative: assume 3 min transfer with high variance
    return this._normalCDF(bufferTimeSec, 180, 60);
  }

  /**
   * Normal CDF approximation (Abramowitz and Stegun)
   * P(X <= x) where X ~ N(mean, stddev)
   */
  _normalCDF(x, mean, stddev) {
    if (stddev <= 0) return x >= mean ? 1 : 0;
    const z = (x - mean) / stddev;
    // Approximation for standard normal CDF
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327; // 1/sqrt(2*pi)
    const p = d * Math.exp(-z * z / 2) *
      (t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))));
    return z > 0 ? 1 - p : p;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  STATS
  // ═══════════════════════════════════════════════════════════════════════════

  getStats() {
    const byType = {};
    const bySource = {};

    for (const transfers of this.transfers.values()) {
      for (const t of transfers) {
        byType[t.type] = (byType[t.type] || 0) + 1;
        bySource[t.source] = (bySource[t.source] || 0) + 1;
      }
    }

    return {
      totalTransfers: this.transfers.size,
      stationGroups: this.stationGroups.size,
      byType,
      bySource,
    };
  }
}
