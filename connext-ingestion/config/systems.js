// connext-ingestion/config/systems.js
// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM REGISTRY
// To add a new transit system:
//   1. Run: npm run add-system -- --id <id> --name <name> --city <city>
//   2. Edit the generated adapter in src/adapters/<id>.js
//   3. Add the entry below
//   4. Run: npm run validate
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEMS = {
  mta: {
    id: "mta",
    name: "MTA",
    city: "New York City",
    region: { lat: 40.7128, lng: -74.006, radiusKm: 50 },
    enabled: true,
    adapter: "mta",

    // GTFS-RT feed URLs — each system can have any combination
    feeds: {
      tripUpdates: [
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",         // 1/2/3/4/5/6/S
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",      // A/C/E
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",     // B/D/F/M
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",        // G
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",       // J/Z
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",        // L
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",     // N/Q/R/W
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-7",        // 7
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",       // SIR
      ],
      vehiclePositions: [
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
      ],
      alerts: [
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts",
      ],
    },

    // Auth config — each system handles auth differently
    auth: {
      type: "header",            // "header", "query", "none"
      headerName: "x-api-key",
      envVar: "MTA_API_KEY",     // reads from process.env
    },

    // Polling intervals (ms)
    intervals: {
      tripUpdates: 15_000,
      vehiclePositions: 30_000,
      alerts: 60_000,
    },

    // Static GTFS source for schedule data
    staticGtfs: {
      url: "http://web.mta.info/developers/data/nyct/subway/google_transit.zip",
      refreshDays: 14,
    },
  },

  mbta: {
    id: "mbta",
    name: "MBTA",
    city: "Boston",
    region: { lat: 42.3601, lng: -71.0589, radiusKm: 30 },
    enabled: true,
    adapter: "mbta",

    feeds: {
      tripUpdates: ["https://cdn.mbta.com/realtime/TripUpdates.pb"],
      vehiclePositions: ["https://cdn.mbta.com/realtime/VehiclePositions.pb"],
      alerts: ["https://cdn.mbta.com/realtime/Alerts.pb"],
    },

    auth: {
      type: "query",
      queryParam: "api_key",
      envVar: "MBTA_API_KEY",
    },

    intervals: {
      tripUpdates: 15_000,
      vehiclePositions: 30_000,
      alerts: 60_000,
    },

    staticGtfs: {
      url: "https://cdn.mbta.com/MBTA_GTFS.zip",
      refreshDays: 7,
    },
  },

  cta: {
    id: "cta",
    name: "CTA",
    city: "Chicago",
    region: { lat: 41.8781, lng: -87.6298, radiusKm: 40 },
    enabled: true,
    adapter: "cta",

    feeds: {
      tripUpdates: ["https://www.transitchicago.com/api/1.0/gtfs/tripupdates.aspx"],
      vehiclePositions: ["https://www.transitchicago.com/api/1.0/gtfs/vehiclepositions.aspx"],
      alerts: ["https://www.transitchicago.com/api/1.0/gtfs/alerts.aspx"],
    },

    auth: {
      type: "query",
      queryParam: "key",
      envVar: "CTA_API_KEY",
    },

    intervals: {
      tripUpdates: 30_000,
      vehiclePositions: 30_000,
      alerts: 60_000,
    },

    staticGtfs: {
      url: "https://www.transitchicago.com/downloads/sch_data/google_transit.zip",
      refreshDays: 14,
    },
  },

  septa: {
    id: "septa",
    name: "SEPTA",
    city: "Philadelphia",
    region: { lat: 39.9526, lng: -75.1652, radiusKm: 35 },
    enabled: true,
    adapter: "septa",

    feeds: {
      tripUpdates: ["https://www3.septa.org/gtfsrt/septa-pa-us/Trip/rtTripUpdates.pb"],
      vehiclePositions: ["https://www3.septa.org/gtfsrt/septa-pa-us/Vehicle/rtVehiclePosition.pb"],
      alerts: ["https://www3.septa.org/gtfsrt/septa-pa-us/Alert/rtAlerts.pb"],
    },

    auth: {
      type: "none",
    },

    intervals: {
      tripUpdates: 30_000,
      vehiclePositions: 60_000,
      alerts: 60_000,
    },

    staticGtfs: {
      url: "https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip",
      refreshDays: 14,
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL CONFIG
// ─────────────────────────────────────────────────────────────────────────────
export const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
  keyPrefix: "connext:",
  defaultTTL: 45,         // seconds — slightly longer than fastest poll interval
};

export const PG_CONFIG = {
  host: process.env.PG_HOST || "127.0.0.1",
  port: parseInt(process.env.PG_PORT || "5432"),
  database: process.env.PG_DATABASE || "connext",
  user: process.env.PG_USER || "connext",
  password: process.env.PG_PASSWORD || "connext",
};

export const INGESTION_CONFIG = {
  maxRetries: 3,
  retryDelayMs: 2_000,
  fetchTimeoutMs: 10_000,
  maxFeedSizeBytes: 10 * 1024 * 1024,   // 10 MB safety limit
  logLevel: process.env.LOG_LEVEL || "info",
};
