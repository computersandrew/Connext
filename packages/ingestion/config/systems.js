// config/systems.js
// ────────────────────────────────────────────────────────
// SYSTEM REGISTRY — add new transit systems here
// ────────────────────────────────────────────────────────

export const SYSTEMS = {
  mta: {
    id: "mta",
    name: "MTA",
    city: "New York City",
    region: { lat: 40.7128, lng: -74.006, radiusKm: 50 },
    enabled: true,
    adapter: "mta",
    feeds: {
      tripUpdates: [
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-ace",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-bdfm",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-g",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-jz",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-l",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-nqrw",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-7",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs-si",
      ],
      vehiclePositions: [
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct/gtfs",
      ],
      alerts: [
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys/subway-alerts",
      ],
    },
    auth: { type: "none"},
    intervals: { tripUpdates: 15000, vehiclePositions: 30000, alerts: 60000 },
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
    auth: { type: "query", queryParam: "api_key", envVar: "MBTA_API_KEY" },
    intervals: { tripUpdates: 15000, vehiclePositions: 30000, alerts: 60000 },
    staticGtfs: { url: "https://cdn.mbta.com/MBTA_GTFS.zip", refreshDays: 7 },
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
    auth: { type: "query", queryParam: "key", envVar: "CTA_API_KEY" },
    intervals: { tripUpdates: 30000, vehiclePositions: 30000, alerts: 60000 },
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
    auth: { type: "none" },
    intervals: { tripUpdates: 30000, vehiclePositions: 60000, alerts: 60000 },
    staticGtfs: {
      url: "https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip",
      refreshDays: 14,
    },
  },
};

// Global config
export const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
  keyPrefix: "connext:",
  defaultTTL: 45,
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
  retryDelayMs: 2000,
  fetchTimeoutMs: 10000,
  maxFeedSizeBytes: 10 * 1024 * 1024,
  logLevel: process.env.LOG_LEVEL || "info",
};
