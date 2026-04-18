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
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
        // "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-7", // returns XML error page, not protobuf
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",
      ],
      vehiclePositions: [
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
      ],
      alerts: [
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts",
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
      tripUpdates: [],
      vehiclePositions: [],
      alerts: [],
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
      alerts: [], // SEPTA GTFS-RT alerts endpoint is 404; handled by JSON API in SeptaAdapter._fetchAlerts()
    },
    auth: { type: "none" },
    intervals: { tripUpdates: 30000, vehiclePositions: 60000, alerts: 60000 },
    staticGtfs: {
      url: "https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip",
      refreshDays: 14,
    },
  },

  rtd: {
    id: "rtd",
    name: "RTD Denver",
    city: "Denver",
    region: { lat: 39.7392, lng: -104.9903, radiusKm: 60 },
    enabled: true,
    adapter: "rtd",
    feeds: {
      tripUpdates:      ["https://open-data.rtd-denver.com/files/gtfs-rt/rtd/TripUpdate.pb"],
      vehiclePositions: ["https://open-data.rtd-denver.com/files/gtfs-rt/rtd/VehiclePosition.pb"],
      alerts:           ["https://open-data.rtd-denver.com/files/gtfs-rt/rtd/Alerts.pb"],
    },
    auth: { type: "none" },
    intervals: { tripUpdates: 15000, vehiclePositions: 30000, alerts: 60000 },
    staticGtfs: {
      url: "https://www.rtd-denver.com/files/gtfs/google_transit.zip",
      refreshDays: 14,
    },
  },

  bustang: {
    id: "bustang",
    name: "Bustang",
    city: "Colorado (Statewide)",
    region: { lat: 39.5501, lng: -105.7821, radiusKm: 300 },
    enabled: true,
    adapter: "bustang",
    feeds: {
      tripUpdates:      ["https://open-data.rtd-denver.com/files/gtfs-rt/cdot/Bustang_TripUpdate.pb"],
      vehiclePositions: ["https://open-data.rtd-denver.com/files/gtfs-rt/cdot/Bustang_VehiclePosition.pb"],
      alerts:           [],
    },
    auth: { type: "none" },
    intervals: { tripUpdates: 30000, vehiclePositions: 60000, alerts: 60000 },
    staticGtfs: {
      url: "https://www.rtd-denver.com/files/gtfs/bustang-co-us.zip",
      refreshDays: 14,
    },
  },

  cdta: {
    id: "cdta",
    name: "CDTA",
    city: "Albany/Troy",
    region: { lat: 42.6526, lng: -73.7562, radiusKm: 40 },
    enabled: true,
    adapter: "cdta",
    feeds: {
      tripUpdates: [],
      vehiclePositions: [],
      alerts: [],
    },
    auth: { type: "none" },
    intervals: { tripUpdates: 30000, vehiclePositions: 30000, alerts: 60000 },
    staticGtfs: {
      url: "https://www.cdta.org/schedules/google_transit.zip",
      refreshDays: 14,
    },
  },

  lametro: {
    id: "lametro",
    name: "LA Metro Rail",
    city: "Los Angeles",
    region: { lat: 34.0522, lng: -118.2437, radiusKm: 60 },
    enabled: true,
    adapter: "lametro",
    feeds: {
      // LA Metro real-time is served via a proprietary JSON REST API.
      // GTFS-RT protobuf feeds can be added here if Metro ever publishes them.
      tripUpdates: [],
      vehiclePositions: [],
      alerts: [],
    },
    auth: { type: "none" },
    intervals: { tripUpdates: 30000, vehiclePositions: 15000, alerts: 60000 },
    staticGtfs: {
      // Rail-only GTFS (A/B/C/D/E/K/L/J lines)
      url: "https://gitlab.com/LACMTA/gtfs_rail/-/raw/master/gtfs_rail.zip",
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
