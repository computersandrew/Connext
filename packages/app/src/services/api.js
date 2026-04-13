// src/services/api.js
// On web, use the same host as the page (works for localhost preview and LAN).
// On native (iOS/Android), fall back to the configured LAN IP.
const NATIVE_IP = "129.161.196.39";
const _isWeb = typeof window !== "undefined" && typeof document !== "undefined";
const _apiHost = _isWeb ? window.location.hostname : NATIVE_IP;
const API_BASE = `http://${_apiHost}:3000`;
const WS_BASE = `ws://${_apiHost}:3000`;

async function get(path) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return res.json();
  } catch (err) {
    if (err.message?.includes("Network request failed")) {
      throw new Error("Cannot reach server — is the API running?");
    }
    throw err;
  }
}

export const api = {
  health: () => get("/api/v1/health"),
  systems: () => get("/api/v1/systems"),

  alerts: () => get("/api/v1/alerts"),
  alertsBySystem: (system) => get(`/api/v1/alerts/${system}`),

  departureStops: (system) => get(`/api/v1/departures/${system}`),
  departures: (system, stop, opts = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", opts.limit);
    if (opts.route) params.set("route", opts.route);
    const qs = params.toString();
    return get(`/api/v1/departures/${system}/${stop}${qs ? "?" + qs : ""}`);
  },

  // Stop name search (from PostgreSQL GTFS data)
  searchStops: (system, query) => get(`/api/v1/stops/${system}/search?q=${encodeURIComponent(query)}`),

  // Search across all systems
  searchAllStops: async (query) => {
    const systems = ["mta", "mbta", "cta", "septa"];
    const results = [];
    const promises = systems.map(async (sys) => {
      try {
        const data = await get(`/api/v1/stops/${sys}/search?q=${encodeURIComponent(query)}`);
        for (const stop of (data.stops || [])) {
          results.push({ system: sys, ...stop });
        }
      } catch {}
    });
    await Promise.all(promises);
    return results;
  },

  plan: (system, from, to, opts = {}) => {
    const params = new URLSearchParams({ from, to });
    if (opts.depart) params.set("depart", opts.depart);
    if (opts.pace) params.set("pace", opts.pace);
    if (opts.walkDistKm != null) params.set("walkDistKm", opts.walkDistKm.toFixed(4));
    if (opts.lat != null) params.set("lat", opts.lat.toFixed(6));
    if (opts.lng != null) params.set("lng", opts.lng.toFixed(6));
    return get(`/api/v1/plan/${system}?${params}`);
  },

  fares: (system) => get(`/api/v1/fares/${system}`),
  fareForRoute: (system, routeId) => get(`/api/v1/fares/${system}/route/${encodeURIComponent(routeId)}`),

  vehicles: (system) => get(`/api/v1/vehicles/${system}`),
  vehicleByTrip: (system, tripId) => get(`/api/v1/vehicles/${system}/trip/${encodeURIComponent(tripId)}`),

  transfer: (system, fromStop, toStop) =>
    get(`/api/v1/transfer/${system}/${fromStop}/${toStop}`),
};

export function connectAlertStream(systems = [], onMessage) {
  const ws = new WebSocket(`${WS_BASE}/ws/alerts`);
  ws.onopen = () => { if (systems.length > 0) ws.send(JSON.stringify({ systems })); };
  ws.onmessage = (event) => {
    try { const data = JSON.parse(event.data); if (data.type !== "heartbeat") onMessage(data); } catch {}
  };
  ws.onerror = () => {};
  ws.onclose = () => { setTimeout(() => connectAlertStream(systems, onMessage), 5000); };
  return ws;
}

export function connectDepartureStream(system, stop, onMessage) {
  const ws = new WebSocket(`${WS_BASE}/ws/departures/${system}/${stop}`);
  ws.onmessage = (event) => {
    try { const data = JSON.parse(event.data); if (data.type === "departures") onMessage(data); } catch {}
  };
  ws.onerror = () => {};
  ws.onclose = () => { setTimeout(() => connectDepartureStream(system, stop, onMessage), 5000); };
  return ws;
}

export { API_BASE, WS_BASE };
