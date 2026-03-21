// src/services/api.js
const API_BASE = "http://129.161.196.239:3000";
const WS_BASE = "ws://129.161.196.239:3000";

// ─── REST helpers ────────────────────────────────────────────────────────────
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

// ─── Endpoints ───────────────────────────────────────────────────────────────
export const api = {
  // Health
  health: () => get("/api/v1/health"),
  systems: () => get("/api/v1/systems"),

  // Alerts
  alerts: () => get("/api/v1/alerts"),
  alertsBySystem: (system) => get(`/api/v1/alerts/${system}`),

  // Departures
  departureStops: (system) => get(`/api/v1/departures/${system}`),
  departures: (system, stop, opts = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", opts.limit);
    if (opts.route) params.set("route", opts.route);
    const qs = params.toString();
    return get(`/api/v1/departures/${system}/${stop}${qs ? "?" + qs : ""}`);
  },

  // Route planner
  plan: (system, from, to, opts = {}) => {
    const params = new URLSearchParams({ from, to });
    if (opts.depart) params.set("depart", opts.depart);
    if (opts.pace) params.set("pace", opts.pace);
    return get(`/api/v1/plan/${system}?${params}`);
  },

  // Transfers
  transfer: (system, fromStop, toStop) =>
    get(`/api/v1/transfer/${system}/${fromStop}/${toStop}`),
};

// ─── WebSocket helpers ───────────────────────────────────────────────────────
export function connectAlertStream(systems = [], onMessage) {
  const ws = new WebSocket(`${WS_BASE}/ws/alerts`);

  ws.onopen = () => {
    if (systems.length > 0) {
      ws.send(JSON.stringify({ systems }));
    }
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type !== "heartbeat") {
        onMessage(data);
      }
    } catch {}
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    // Auto-reconnect after 5s
    setTimeout(() => connectAlertStream(systems, onMessage), 5000);
  };

  return ws;
}

export function connectDepartureStream(system, stop, onMessage) {
  const ws = new WebSocket(`${WS_BASE}/ws/departures/${system}/${stop}`);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "departures") {
        onMessage(data);
      }
    } catch {}
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    setTimeout(() => connectDepartureStream(system, stop, onMessage), 5000);
  };

  return ws;
}

export { API_BASE, WS_BASE };
